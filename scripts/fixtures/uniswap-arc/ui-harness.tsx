// Local browser regression harness. Wallet connector and HTTP/RPC are test doubles.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig } from 'wagmi'
import { mock } from '@wagmi/core'
import { connect, disconnect, switchChain } from '@wagmi/core'
import { custom, defineChain } from 'viem'
import MainnetSwapScreen from '../../../src/components/MainnetSwapScreen'

const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const other = '0x2222222222222222222222222222222222222222' as const
const arc = defineChain({ id: 5042, name: 'Arc test double', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1/never-rpc'] } } })
const wrong = defineChain({ ...arc, id: 1, name: 'Wrong network test double' })
const transport = custom({ request: async () => { throw new Error('external_rpc_forbidden_in_ui_test') } })
const config = createConfig({ chains: [arc, wrong], connectors: [mock({ accounts: [owner, other] })], transports: { 5042: transport, 1: transport }, storage: null })
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

Object.assign(window, { uniswapUiTest: {
  connect: (chainId = 5042) => connect(config, { connector: config.connectors[0], chainId }),
  disconnect: () => disconnect(config),
  chain: (chainId: number) => switchChain(config, { chainId }),
  account: (change = false) => config.connectors[0].onAccountsChanged([change ? other : owner]),
} })
createRoot(document.getElementById('root')!).render(<WagmiProvider config={config}><QueryClientProvider client={queryClient}><MainnetSwapScreen /></QueryClientProvider></WagmiProvider>)
