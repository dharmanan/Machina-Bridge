import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import CountdownPage from './countdown/CountdownPage'
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

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const isCountdownRoute = pathname === '/countdown'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Web3Provider>
      {isCountdownRoute ? <CountdownPage /> : <App />}
    </Web3Provider>
  </StrictMode>,
)
