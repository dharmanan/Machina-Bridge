// Controlled harness for the Solana Bridge panel: the real MainnetSolanaCanary
// renders; wagmi, Phantom and the Solana CCTP hook are test stand-ins (see
// verify-solana-bridge-ui.mjs). Never imported by the application entry.
import React from 'react'
import { createRoot } from 'react-dom/client'
import MainnetSolanaCanary from '../../src/components/MainnetSolanaCanary'

createRoot(document.getElementById('root')!).render(<div className="mx-auto max-w-xl p-4"><MainnetSolanaCanary /></div>)
