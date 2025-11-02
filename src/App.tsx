import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { SwapTab } from './components/SwapTab'
import { BridgeTab } from './components/BridgeTab'
import { DashboardTab } from './components/DashboardTab'
import { Container } from './components/ui'
import { Zap, GitBranch, BarChart3 } from 'lucide-react'
import './index.css'

type Tab = 'swap' | 'bridge' | 'dashboard'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('swap')

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'swap', label: 'Swap', icon: <Zap size={20} /> },
    { id: 'bridge', label: 'Bridge', icon: <GitBranch size={20} /> },
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={20} /> },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900">
      {/* Header */}
      <header className="border-b border-dark-700 sticky top-0 z-50 bg-dark-900/80 backdrop-blur-lg">
        <Container className="py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg flex items-center justify-center">
              <Zap size={24} className="text-white" />
            </div>
            <h1 className="text-xl font-bold">Arc Bridge Swap</h1>
          </div>
          <ConnectButton />
        </Container>
      </header>

      {/* Navigation Tabs */}
      <div className="border-b border-dark-700 bg-dark-900/50 sticky top-16 z-40">
        <Container>
          <nav className="flex gap-8 py-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 pb-2 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-dark-400 hover:text-white'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </nav>
        </Container>
      </div>

      {/* Content */}
      <main>
        {activeTab === 'swap' && <SwapTab />}
        {activeTab === 'bridge' && <BridgeTab />}
        {activeTab === 'dashboard' && <DashboardTab />}
      </main>

      {/* Footer */}
      <footer className="border-t border-dark-700 py-8 mt-12">
        <Container>
          <div className="text-center text-dark-400 text-sm">
            <p>Sepolia Testnet • Arc Testnet</p>
            <p className="mt-2">
              Built with Uniswap V2 & Circle Bridge Kit
            </p>
          </div>
        </Container>
      </footer>
    </div>
  )
}
