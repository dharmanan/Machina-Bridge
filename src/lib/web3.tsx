import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from './wagmi.config'

const queryClient = new QueryClient()

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider
          networks={{
            testnet: {
              url: 'https://fullnode.testnet.sui.io:443',
              network: 'testnet',
            },
          }}
          defaultNetwork="testnet"
        >
          <WalletProvider
            autoConnect
            slushWallet={{ name: 'Slush' }}
            preferredWallets={['Slush', 'Phantom']}
          >
            <RainbowKitProvider>
              {children}
            </RainbowKitProvider>
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}