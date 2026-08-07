import { StrictMode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import CountdownPage from './countdown/CountdownPage'
import FinalizeProductionCountdownPage from './countdown/FinalizeProductionCountdownPage'
import DesignedByFooter from './components/DesignedByFooter'
import '@rainbow-me/rainbowkit/styles.css'
import '@mysten/dapp-kit/dist/index.css'
import { Web3Provider } from './lib/web3'
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
const isFinalizeProductionRoute = pathname === '/countdown/deploy'

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

function PublicDesignedByFooter() {
  return (
    <div className="border-t border-slate-200 bg-white/70 py-4">
      <div className="mx-auto flex max-w-7xl justify-center px-4 sm:px-6 lg:px-8">
        <DesignedByFooter />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Web3Provider>
      {isFinalizeProductionRoute ? (
        <FinalizeProductionCountdownPage />
      ) : isCountdownRoute ? (
        <>
          <CountdownPage />
          <PublicDesignedByFooter />
        </>
      ) : (
        <>
          <App />
          <CountdownNavLink />
          <PublicDesignedByFooter />
        </>
      )}
    </Web3Provider>
  </StrictMode>,
)
