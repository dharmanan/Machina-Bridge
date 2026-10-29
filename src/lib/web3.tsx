import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from './wagmi.config'
import { SUI_NETWORKS } from '../config/sui'
import { readStoredAppNetwork } from '../config/runtime'

const queryClient = new QueryClient()

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider
          networks={SUI_NETWORKS}
          defaultNetwork={readStoredAppNetwork()}
        >
          <WalletProvider
            autoConnect
            slushWallet={{ name: 'Slush' }}
            preferredWallets={['Slush', 'Phantom']}
          >
            <RainbowKitProvider locale="en-US">
              {children}
            </RainbowKitProvider>
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
