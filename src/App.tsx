import { useState, useEffect, useRef } from 'react'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { SwapTab } from './components/SwapTab'
import { BridgeTab } from './components/BridgeTab'
import { DashboardTab } from './components/DashboardTab'
import { Container } from './components/ui'
import { usePhantomSolana } from './hooks/usePhantomSolana'
import { useSuiWallet } from './hooks/useSuiWallet'
import { SUPPORTED_EVM_CHAIN_OPTIONS, addChainToWallet, getSupportedEvmChain, getSupportedEvmChainName } from './lib/chains'
import { logger } from './lib/logger'
import { Zap, GitBranch, BarChart3, Twitter, Github, ChevronDown, Droplets, AlertTriangle, X } from 'lucide-react'
import arcLogo from './assets/arc.png'
import './index.css'

type Tab = 'swap' | 'bridge' | 'dashboard'

export default function App() {
  const { isConnected, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: walletClient } = useWalletClient()
  const {
    address: phantomSolanaAddress,
    connect: connectPhantomSolana,
    disconnect: disconnectPhantomSolana,
    error: phantomSolanaError,
    isConnected: isPhantomConnected,
    isConnecting: isConnectingPhantomSolana,
    isPhantomInstalled,
  } = usePhantomSolana()
  const {
    connect: connectSuiWallet,
    currentWalletName: suiCurrentWalletName,
    defaultWalletName: defaultSuiWalletName,
    disconnect: disconnectSuiWallet,
    error: suiWalletError,
    isConnected: isSuiWalletConnected,
    isConnecting: isConnectingSuiWallet,
    isWalletAvailable: isSuiWalletAvailable,
  } = useSuiWallet()
  const [activeTab, setActiveTab] = useState<Tab>('swap')
  const [showNetworkDropdown, setShowNetworkDropdown] = useState(false)
  const [showLendingDropdown, setShowLendingDropdown] = useState(false)
  const [isMobileExperience, setIsMobileExperience] = useState(false)
  const [hasDismissedMobileNotice, setHasDismissedMobileNotice] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const lendingDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const mobileQuery = window.matchMedia('(max-width: 768px), (pointer: coarse)')
    const syncMobileExperience = () => {
      const userAgent = window.navigator.userAgent || ''
      const isMobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)
      setIsMobileExperience(mobileQuery.matches || isMobileUserAgent)
    }

    syncMobileExperience()
    mobileQuery.addEventListener?.('change', syncMobileExperience)
    window.addEventListener('orientationchange', syncMobileExperience)

    return () => {
      mobileQuery.removeEventListener?.('change', syncMobileExperience)
      window.removeEventListener('orientationchange', syncMobileExperience)
    }
  }, [])

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowNetworkDropdown(false)
      }
      if (lendingDropdownRef.current && !lendingDropdownRef.current.contains(event.target as Node)) {
        setShowLendingDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'swap', label: 'Swap', icon: <Zap size={20} /> },
    { id: 'bridge', label: 'Bridge', icon: <GitBranch size={20} /> },
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={20} /> },
  ]

  const networks = SUPPORTED_EVM_CHAIN_OPTIONS

  const handleNetworkSwitch = async (networkId: number) => {
    const targetChain = getSupportedEvmChain(networkId)
    const walletRequest =
      walletClient
        ? ((args: { method: string; params?: unknown[] }) => walletClient.transport.request(args as never))
        : typeof window !== 'undefined' && typeof window.ethereum?.request === 'function'
          ? window.ethereum.request.bind(window.ethereum)
        : null

    try {
      await switchChainAsync({ chainId: networkId })
    } catch (error) {
      if (targetChain && walletRequest) {
        await addChainToWallet(targetChain, walletRequest)
        await switchChainAsync({ chainId: networkId })
      } else {
        logger.warn('Unable to switch network:', error)
      }
    }

    setShowNetworkDropdown(false)
  }

  const handlePhantomAction = async () => {
    try {
      if (isPhantomConnected) {
        await disconnectPhantomSolana()
        return
      }

      await connectPhantomSolana()
    } catch (error) {
      logger.warn('Unable to change Phantom Solana connection state:', error)
    }
  }

  const handleSuiWalletAction = async () => {
    try {
      if (isSuiWalletConnected) {
        await disconnectSuiWallet()
        return
      }

      await connectSuiWallet(defaultSuiWalletName)
    } catch (error) {
      logger.warn('Unable to change Sui wallet connection state:', error)
    }
  }

  const showMobileNotice = isMobileExperience && !hasDismissedMobileNotice

  return (
    <div className="min-h-screen bg-transparent text-slate-900">
      {showMobileNotice && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-warning-title"
            className="relative w-full max-w-md rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
          >
            <button
              type="button"
              onClick={() => setHasDismissedMobileNotice(true)}
              className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
              aria-label="Close mobile notice"
            >
              <X size={16} />
            </button>

            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
              <AlertTriangle size={22} />
            </div>

            <h2 id="mobile-warning-title" className="text-xl font-semibold tracking-tight text-slate-900">
              Mobile notice
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              This version is not optimized for mobile devices. Please use a desktop browser for the best experience.
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              You can continue on mobile, but wallet connections and transaction flows may not work as expected.
            </p>

            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setHasDismissedMobileNotice(true)}
                className="inline-flex w-full items-center justify-center rounded-2xl bg-[#2F6E0C] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#25580A]"
              >
                Continue on mobile
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/85 backdrop-blur-lg">
        <Container className="py-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)] lg:items-center lg:gap-8">
            <div className="flex items-start gap-4">
              <img src={arcLogo} alt="Arc Logo" className="h-12 w-12 flex-shrink-0 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm lg:h-14 lg:w-14" />
              <div className="min-w-0 pt-0.5">
                <a
                  href="https://docs.arc.network/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-[#2F6E0C]"
                >
                  <h1 className="text-[1.9rem] font-semibold leading-[0.95] tracking-tight text-slate-900 sm:text-[2.05rem] lg:text-[2.15rem]">Arc Bridge</h1>
                </a>
                <p className="mt-2 max-w-[30rem] text-sm leading-6 text-slate-500 sm:text-base sm:leading-7">
                  Simple testnet swap and bridge flows for Arc, Sepolia, and Solana.
                </p>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2 lg:items-end">
                {/* Row 1 — Social icons + EVM network switcher + wallet */}
                <div className="flex items-center gap-2 lg:justify-end">
                  <a
                    href="https://x.com/KohenEric"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                  >
                    <Twitter size={16} />
                  </a>
                  <a
                    href="https://github.com/dharmanan"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                  >
                    <Github size={16} />
                  </a>
                {isConnected && (
                  <div className="relative" ref={dropdownRef}>
                    <button
                      onClick={() => setShowNetworkDropdown(!showNetworkDropdown)}
                      className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
                    >
                      <span>{getSupportedEvmChainName(chainId)}</span>
                      <ChevronDown size={13} className={`transition-transform ${showNetworkDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showNetworkDropdown && (
                      <div className="absolute right-0 top-full z-50 mt-2 min-w-[160px] rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                        {networks.map((network) => (
                          <button
                            key={network.id}
                            onClick={() => handleNetworkSwitch(network.id)}
                            className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                              chainId === network.id ? 'text-[#2F6E0C]' : 'text-slate-700'
                            }`}
                          >
                            {network.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
              </div>

              {/* Row 2 — Solana + Sui side by side */}
              <div className="flex items-center gap-3 lg:justify-end">
                {/* Solana */}
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${isPhantomConnected ? 'bg-green-500' : 'bg-slate-300'}`} />
                  <span className="text-xs text-slate-600">
                    {isPhantomConnected ? 'Connected Solana' : 'Solana'}
                  </span>
                  <button
                    onClick={handlePhantomAction}
                    disabled={!isPhantomInstalled || isConnectingPhantomSolana}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isConnectingPhantomSolana ? '...' : isPhantomConnected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>

                <div className="h-4 w-px bg-slate-200" />

                {/* Sui */}
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${isSuiWalletConnected ? 'bg-sky-500' : 'bg-slate-300'}`} />
                  <span className="text-xs text-slate-600">
                    {isSuiWalletConnected ? 'Connected Sui' : 'Sui'}
                  </span>
                  <button
                    onClick={handleSuiWalletAction}
                    disabled={(!isSuiWalletAvailable && !isSuiWalletConnected) || isConnectingSuiWallet}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isConnectingSuiWallet ? '...' : isSuiWalletConnected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>

              {/* Row 3 — wallet name status */}
              <p className="text-[11px] text-slate-400 lg:text-right">
                Solana wallet: {isPhantomConnected ? 'Phantom' : '—'}
                {' · '}
                Sui wallet: {isSuiWalletConnected ? (suiCurrentWalletName || 'Connected') : '—'}
              </p>

              {(phantomSolanaError || suiWalletError) && (
                <div className="text-[11px] text-red-500 lg:text-right">
                  {phantomSolanaError && <p>{phantomSolanaError}</p>}
                  {suiWalletError && <p>{suiWalletError}</p>}
                </div>
              )}
            </div>
          </div>
        </Container>
      </header>

      <div className="border-b border-slate-200 bg-[#f7f9f5]/70">
        <Container>
          <nav className="flex flex-wrap gap-2 py-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C] shadow-sm'
                    : 'border border-transparent text-slate-500 hover:border-slate-200 hover:bg-white hover:text-slate-900'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}

            <div className="relative" ref={lendingDropdownRef}>
              <button
                onClick={() => setShowLendingDropdown(!showLendingDropdown)}
                className="inline-flex items-center gap-2 rounded-full border border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-slate-200 hover:bg-white hover:text-slate-900"
              >
                Lending
                <ChevronDown size={14} className={`transition-transform ${showLendingDropdown ? 'rotate-180' : ''}`} />
              </button>
              {showLendingDropdown && (
                <div className="absolute left-0 top-full z-50 mt-2 min-w-[160px] rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                  <span
                    className="block cursor-not-allowed rounded-lg px-3 py-2 text-sm text-slate-400"
                    onClick={() => setShowLendingDropdown(false)}
                  >
                    Arc Lending
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Soon
                    </span>
                  </span>
                </div>
              )}
            </div>

            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-slate-200 hover:bg-white hover:text-slate-900"
            >
              <Droplets size={18} />
              Faucet
            </a>
          </nav>
        </Container>
      </div>

      <main className="pb-10">
        {activeTab === 'swap' && <SwapTab />}
        {activeTab === 'bridge' && <BridgeTab />}
        {activeTab === 'dashboard' && <DashboardTab />}
      </main>

      <footer className="mt-12 border-t border-slate-200 py-8">
        <Container>
          <div className="text-center text-sm text-slate-500">
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
              <p className="mb-2 font-semibold text-[#2F6E0C]">
                MVP Testnet Application - Educational v2.2 for{' '}
                <a
                  href="https://docs.arc.network/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#2F6E0C] underline transition-colors hover:text-[#25580A]"
                >
                  ARC Protocol
                </a>
              </p>
              <p>This is a testnet demo application for learning and testing ARC Protocol features. Not for production use. All transactions use test tokens with no real value.</p>
            </div>
          </div>
        </Container>
      </footer>
    </div>
  )
}
