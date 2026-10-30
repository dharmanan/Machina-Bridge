// Controlled harness for the Earn deposit/withdraw send path. The real
// MainnetEarnActions component renders; wagmi, EarnKit and the viem adapter are
// test stand-ins (see verify-mainnet-earn-safety-ui.mjs). Never imported by the app.
import React from 'react'
import { createRoot } from 'react-dom/client'
import MainnetEarnActions from '../../src/components/MainnetEarnActions'

createRoot(document.getElementById('root')!).render(<MainnetEarnActions />)
