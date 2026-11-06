import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import '@rainbow-me/rainbowkit/styles.css'
import '@mysten/dapp-kit/dist/index.css'
import { Web3Provider } from './lib/web3'
import { installCircleResponseLimits } from './lib/circleResponseLimits'
import './index.css'

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  global?: typeof globalThis
}

globalScope.Buffer ??= Buffer
globalScope.global ??= globalThis

// Once, before any render: bounds Circle Borrow/Swap service bodies and Iris /v2/messages/ reads.
// Every other request (Earn, RPC, wallets, other Circle paths) passes through unchanged.
installCircleResponseLimits()

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <Web3Provider>
      <App />
    </Web3Provider>
  </StrictMode>,
)
