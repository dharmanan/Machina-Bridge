import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { MainnetTransferRecovery } from '../../src/components/MainnetTransferRecovery'
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-xl p-4"><MainnetTransferRecovery /></main>)
