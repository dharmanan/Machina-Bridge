import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Web3Provider>
      <App />
    </Web3Provider>
  </StrictMode>,
)
