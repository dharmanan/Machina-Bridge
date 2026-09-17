import { StrictMode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import CountdownPage from './countdown/CountdownPage'
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
import './countdown/countdown-layout.css'

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  global?: typeof globalThis
}

globalScope.Buffer ??= Buffer
globalScope.global ??= globalThis

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const isCountdownRoute = pathname === '/countdown'
const shouldShowLockedMainnetPreview = IS_MAINNET_PROFILE && !MAINNET_RUNTIME_IMPLEMENTED

function CountdownNavLink() {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const locateNavigation = () => {
      const navigation = document.querySelector('nav') as HTMLElement | null
      setNavTarget(navigation)
    }

    locateNavigation()
    const observer = new MutationObserver(locateNavigation)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [])

  if (!navTarget) return null

  return createPortal(
    <a
      href="/countdown"
      className="inline-flex items-center gap-2 rounded-full border border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-slate-200 hover:bg-white hover:text-slate-900"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      Countdown
    </a>,
    navTarget,
  )
}

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
        {isCountdownRoute ? (
          <>
            <CountdownPage />
            <PublicDesignedByFooter />
          </>
        ) : (
          <>
            <App />
            <CountdownNavLink />
            <MainnetPreviewNavLink />
            <PublicDesignedByFooter />
          </>
        )}
      </Web3Provider>
    </StrictMode>,
  )
}
