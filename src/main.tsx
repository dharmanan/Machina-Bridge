import { StrictMode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import DesignedByFooter from './components/DesignedByFooter'
import MainnetPreviewGate from './components/MainnetPreviewGate'
import '@rainbow-me/rainbowkit/styles.css'
import '@mysten/dapp-kit/dist/index.css'
import { Web3Provider } from './lib/web3'
import {
  IS_MAINNET_PROFILE,
  MAINNET_APP_URL,
  MAINNET_PREVIEW_ENABLED,
  MAINNET_RUNTIME_IMPLEMENTED,
} from './config/runtime'
import './index.css'

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  global?: typeof globalThis
}

globalScope.Buffer ??= Buffer
globalScope.global ??= globalThis

const shouldShowLockedMainnetPreview = IS_MAINNET_PROFILE && !MAINNET_RUNTIME_IMPLEMENTED

function MainnetPreviewNavLink() {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!MAINNET_PREVIEW_ENABLED || !MAINNET_APP_URL || IS_MAINNET_PROFILE) {
      return undefined
    }

    const locateNavigation = () => {
      const navigation = document.querySelector('nav') as HTMLElement | null
      setNavTarget(navigation)
    }

    locateNavigation()
    const observer = new MutationObserver(locateNavigation)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [])

  if (!navTarget || !MAINNET_PREVIEW_ENABLED || !MAINNET_APP_URL || IS_MAINNET_PROFILE) {
    return null
  }

  return createPortal(
    <a
      href={MAINNET_APP_URL}
      className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100"
    >
      Mainnet Preview
    </a>,
    navTarget,
  )
}

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

if (shouldShowLockedMainnetPreview) {
  root.render(
    <StrictMode>
      <MainnetPreviewGate />
      <PublicDesignedByFooter />
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <Web3Provider>
        <App />
        <MainnetPreviewNavLink />
        <PublicDesignedByFooter />
      </Web3Provider>
    </StrictMode>,
  )
}
