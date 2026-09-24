import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import DesignedByFooter from './components/DesignedByFooter'
import '@rainbow-me/rainbowkit/styles.css'
import '@mysten/dapp-kit/dist/index.css'
import { Web3Provider } from './lib/web3'
import './index.css'

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  global?: typeof globalThis
}

globalScope.Buffer ??= Buffer
globalScope.global ??= globalThis

function PublicDesignedByFooter() {
  return (
    <div className="border-t border-slate-200 bg-white/70 py-4">
      <div className="mx-auto flex max-w-7xl justify-center px-4 sm:px-6 lg:px-8">
        <DesignedByFooter />
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <Web3Provider>
      <App />
      <PublicDesignedByFooter />
    </Web3Provider>
  </StrictMode>,
)
