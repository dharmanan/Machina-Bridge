import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { SwapTab } from './components/SwapTab'
import { BridgeTab } from './components/BridgeTab'
import { DashboardTab } from './components/DashboardTab'
import MainnetPreviewGate from './components/MainnetPreviewGate'
import MainnetDashboard from './components/MainnetDashboard'
import MainnetEarnPreview from './components/MainnetEarnPreview'
import MainnetWalletActivity from './components/MainnetWalletActivity'
import { Container } from './components/ui'
import { usePhantomSolana } from './hooks/usePhantomSolana'
import { useSuiWallet } from './hooks/useSuiWallet'
import { addChainToWallet, getEvmChainOptionsForNetwork, getSupportedEvmChain, getSupportedEvmChainName } from './lib/chains'
import { logger } from './lib/logger'
import { readStoredAppNetwork, storeAppNetwork, type AppNetwork } from './config/runtime'
import { Zap, GitBranch, BarChart3, Twitter, Github, ChevronDown, Droplets, TrendingUp, Activity as ActivityIcon } from 'lucide-react'
import arcLogo from './assets/arc.png'
import DesignedByFooter from './components/DesignedByFooter'
import WalletBar, { phantomBrowseUrl, slushBrowseUrl } from './components/WalletBar'
import MobileAppBar from './components/MobileAppBar'
import './index.css'

// Borrow is paused: its implementation remains in the repository, but no production
// navigation or route imports it. Retired Intelligence is not loaded by Dashboard.
const MainnetSwapPreview = lazy(() => import('./components/MainnetSwapScreen'))

type Tab = 'swap' | 'bridge' | 'earn' | 'dashboard' | 'activity'

export default function App() {
  const [appNetwork, setAppNetwork] = useState<AppNetwork>(() => readStoredAppNetwork())
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
    address: suiAddress,
    walletSupportsNetwork: suiSupported,
    connect: connectSuiWallet,
    currentWalletName: suiCurrentWalletName,
    defaultWalletName: defaultSuiWalletName,
    disconnect: disconnectSuiWallet,
    error: suiWalletError,
    isConnected: isSuiWalletConnected,
    isConnecting: isConnectingSuiWallet,
    isWalletAvailable: isSuiWalletAvailable,
    hasInjectedWallet: hasInjectedSuiWallet,
  } = useSuiWallet(appNetwork)
  const [activeTab, setActiveTab] = useState<Tab>(() => readStoredAppNetwork() === 'mainnet' ? 'bridge' : 'swap')
  const [showNetworkDropdown, setShowNetworkDropdown] = useState(false)
  const [showLendingDropdown, setShowLendingDropdown] = useState(false)
  const [isMobileExperience, setIsMobileExperience] = useState(false)
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

  const networks = getEvmChainOptionsForNetwork(appNetwork)
  const isCurrentChainInSelectedProfile = Boolean(
    chainId && networks.some((network) => network.id === chainId),
  )
  const selectedNetworkLabel = isCurrentChainInSelectedProfile
    ? getSupportedEvmChainName(chainId)
    : appNetwork === 'mainnet'
      ? 'Select mainnet'
      : 'Select testnet'

  const handleAppNetworkChange = (network: AppNetwork) => {
    if (network === appNetwork) return

    setAppNetwork(network)
    storeAppNetwork(network)
    setShowNetworkDropdown(false)

    if (network === 'mainnet' || activeTab === 'activity') {
      setActiveTab('bridge')
    }
  }

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

  const solanaWallet = { address: phantomSolanaAddress ?? null, connecting: isConnectingPhantomSolana, available: isPhantomInstalled, error: phantomSolanaError ?? null, connect: () => void handlePhantomAction(), disconnect: () => void handlePhantomAction() }
  const suiWallet = { address: suiAddress, walletName: suiCurrentWalletName, connecting: isConnectingSuiWallet, available: isSuiWalletAvailable, supported: suiSupported, error: suiWalletError, connect: () => void handleSuiWalletAction(), disconnect: () => void handleSuiWalletAction() }
  // Phones/tablets: Phantom is injected only inside its own app browser; Slush also offers its app browser.
  const pageUrl = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`
  const phantomOpenUrl = isMobileExperience && !isPhantomInstalled && pageUrl ? phantomBrowseUrl(pageUrl, window.location.origin) : null
  // Only when no app/extension wallet is injected: inside the Slush app browser the app wallet connects directly.
  const slushOpenUrl = isMobileExperience && !hasInjectedSuiWallet && pageUrl ? slushBrowseUrl(pageUrl) : null
  // MetaMask's in-app browser (its dapp universal link), which the old mobile notice offered.
  const metaMaskOpenUrl = isMobileExperience && pageUrl ? `https://metamask.app.link/dapp/${pageUrl.replace(/^https?:\/\//, '')}` : null
  const mobileNavItems = appNetwork === 'mainnet'
    ? [
        { id: 'bridge', label: 'Bridge', icon: <GitBranch size={18} /> },
        { id: 'swap', label: 'Swap', icon: <Zap size={18} /> },
        { id: 'earn', label: 'Earn', icon: <TrendingUp size={18} /> },
        { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={18} /> },
        { id: 'activity', label: 'Activity', icon: <ActivityIcon size={18} /> },
      ]
    : tabs.map(tab => ({ id: tab.id, label: tab.label, icon: tab.icon }))
  const mobileNavLinks = appNetwork === 'testnet'
    ? [{ label: 'Lending · Arc Machina', href: 'https://arcmachina.xyz/' }, { label: 'Faucet', href: 'https://faucet.circle.com/', icon: <Droplets size={18} /> }]
    : []
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <MobileAppBar
        logoSrc={arcLogo}
        appNetwork={appNetwork}
        evmNetworkName={selectedNetworkLabel}
        phantomOpenUrl={phantomOpenUrl}
        slushOpenUrl={slushOpenUrl}
        metaMaskOpenUrl={metaMaskOpenUrl}
        solana={solanaWallet}
        sui={suiWallet}
        activeTab={activeTab}
        navItems={mobileNavItems}
        navLinks={mobileNavLinks}
        onSelectTab={(id) => setActiveTab(id as Tab)}
        onNetworkChange={handleAppNetworkChange}
        evmNetworks={networks.map((network) => ({ id: network.id, name: network.name }))}
        evmChainId={isCurrentChainInSelectedProfile ? chainId : undefined}
        onEvmNetworkSwitch={(id) => void handleNetworkSwitch(id)}
      />

      <header className="sticky top-0 z-50 hidden border-b border-slate-200 bg-white/85 backdrop-blur-lg md:block">
        <Container className="py-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)] lg:items-center lg:gap-8">
            <div className="flex items-start gap-4">
              <img src={arcLogo} alt="Machina Bridge Logo" className="h-12 w-12 flex-shrink-0 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm lg:h-14 lg:w-14" />
              <div className="min-w-0 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="https://docs.arc.network/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="transition-colors hover:text-[#2F6E0C]"
                  >
                    <h1 className="text-[1.9rem] font-semibold leading-[0.95] tracking-tight text-slate-900 sm:text-[2.05rem] lg:text-[2.15rem]">Machina Bridge</h1>
                  </a>
                  <span className="inline-flex shrink-0 items-center rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-2.5 py-0.5 text-xs font-medium text-[#2F6E0C]">Public Beta</span>
                </div>
                <p className="mt-2 max-w-[30rem] text-sm leading-6 text-slate-500 sm:text-base sm:leading-7">
                  {appNetwork === 'testnet'
                    ? 'Testnet swap and bridge flows for Arc, Sepolia, and Solana.'
                    : 'USDC bridging, mainnet Swap, Earn, and wallet tracking in one app.'}
                </p>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2 lg:items-end">
                {/* Row 1 — Social icons + EVM network switcher + wallet */}
                <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
                  <a
                    href="https://x.com/KohenEric"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                  >
                    <Twitter size={16} />
                  </a>
                  <a
                    href="https://github.com/dharmanan/Machina-Bridge"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                  >
                    <Github size={16} />
                  </a>
                  <div
                    className="inline-flex h-9 flex-shrink-0 items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5 shadow-sm"
                    aria-label="Network environment"
                  >
                    {(['testnet', 'mainnet'] as const).map((network) => (
                      <button
                        key={network}
                        type="button"
                        onClick={() => handleAppNetworkChange(network)}
                        aria-pressed={appNetwork === network}
                        className={`h-8 whitespace-nowrap rounded-[9px] px-3 text-xs font-semibold transition-colors ${
                          appNetwork === network
                            ? 'bg-white text-slate-900 shadow-sm ring-1 ring-[#66D121]/30'
                            : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                        }`}
                      >
                        {network === 'testnet' ? 'Testnet' : 'Mainnet'}
                      </button>
                    ))}
                  </div>
                {isConnected && (
                  <div className="relative" ref={dropdownRef}>
                    <button
                      onClick={() => setShowNetworkDropdown(!showNetworkDropdown)}
                      className="flex h-9 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
                    >
                      <span>{selectedNetworkLabel}</span>
                      <ChevronDown size={13} className={`transition-transform ${showNetworkDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showNetworkDropdown && (
                      <div className="absolute right-0 top-full z-50 mt-2 min-w-[170px] rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
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
              </div>

              <WalletBar
                appNetwork={appNetwork}
                evmNetworkName={selectedNetworkLabel}
                phantomOpenUrl={phantomOpenUrl}
                solana={solanaWallet}
                sui={suiWallet}
              />
            </div>
          </div>
        </Container>
      </header>

      {appNetwork === 'testnet' && (
        <div className="hidden border-b border-slate-200 bg-[#f7f9f5]/70 md:block">
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
                    <a
                      href="https://arcmachina.xyz/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                      onClick={() => setShowLendingDropdown(false)}
                    >
                      Arc Machina
                    </a>
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
      )}

      {appNetwork === 'mainnet' && (
        <div className="hidden border-b border-slate-200 bg-[#f7f9f5]/70 md:block">
          <Container>
            <nav className="flex flex-wrap gap-2 py-4">
              {[
                { id: 'bridge' as const, label: 'Bridge', icon: <GitBranch size={20} /> },
                { id: 'swap' as const, label: 'Swap', icon: <Zap size={20} /> },
                { id: 'earn' as const, label: 'Earn', icon: <TrendingUp size={20} /> },
                { id: 'dashboard' as const, label: 'Dashboard', icon: <BarChart3 size={20} /> },
                { id: 'activity' as const, label: 'Activity', icon: <ActivityIcon size={20} /> },
              ].map((tab) => (
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
            </nav>
          </Container>
        </div>
      )}

      <main className="flex-1">
        {appNetwork === 'mainnet' ? (
          activeTab === 'dashboard'
            ? <MainnetDashboard />
            : activeTab === 'earn'
              ? <MainnetEarnPreview />
              : activeTab === 'swap'
                ? <Suspense fallback={<Container className="py-8"><p className="text-sm text-slate-500">Loading Swap Preview...</p></Container>}><MainnetSwapPreview /></Suspense>
                : activeTab === 'activity'
                  ? <MainnetWalletActivity />
                  : <MainnetPreviewGate />
        ) : (
          <>
            {activeTab === 'swap' && <SwapTab />}
            {activeTab === 'bridge' && <BridgeTab />}
            {activeTab === 'dashboard' && <DashboardTab />}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-3">
        <Container>
          <div className="flex flex-col items-center justify-center gap-2 text-center text-xs text-slate-400 sm:flex-row sm:gap-4">
            <span>
              {appNetwork === 'testnet'
                ? 'Independent Arc testnet application.'
                : 'Independent Arc ecosystem application.'}
            </span>
            <a
              href="https://docs.arc.network/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-slate-500 transition-colors hover:text-[#2F6E0C]"
            >
              Arc documentation
            </a>
            <DesignedByFooter />
          </div>
        </Container>
      </footer>
    </div>
  )
}
