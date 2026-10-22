// Test-only EIP-1193 provider. No key, cryptographic signature, external RPC or actual broadcast.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig } from 'wagmi'
import { mock, connect, disconnect, switchChain } from '@wagmi/core'
import { custom, defineChain, toHex } from 'viem'
import MainnetSwapScreen from '../../../src/components/MainnetSwapScreen'
import '../../../src/index.css'

const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321' as const
const other = '0x2222222222222222222222222222222222222222' as const
const state = { walletMode: 'hash', requests: [] as { method: string; params?: unknown[] }[], tx: null as unknown, hash: '', balanceReads: 0, walletLatestNonce: 7, walletPendingNonce: 7, walletReadFailure: '', numericPending: false, balanceMode: '', tokenBalance: 100000000n }
let release: ((value: string) => void) | undefined
const pendingBalances: ((value: string) => void)[] = []
let selectedAccount: string = owner
const arc = defineChain({ id: 5042, name: 'Arc test double', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1/never-rpc'] } } })
const wrong = defineChain({ ...arc, id: 1, name: 'Wrong network test double' })
const transport = custom({ request: async args => {
  if (args.method === 'eth_getBalance') {
    state.balanceReads++
    if (state.balanceMode === 'error') throw Error('controlled-balance-error')
    if (state.balanceMode === 'held') return new Promise<string>(resolve => { pendingBalances.push(resolve) })
    return toHex(state.balanceMode === 'low' ? 50000000000000000n : 100n * 10n ** 18n)
  }
  if (args.method === 'eth_chainId') return '0x13b2'
  if (args.method === 'eth_call') return toHex(state.tokenBalance, { size: 32 })
  throw new Error('unexpected_wagmi_read')
} })
const config = createConfig({ chains: [arc, wrong], connectors: [mock({ accounts: [owner, other] })], transports: { 5042: transport, 1: transport }, storage: null })
const connector = config.connectors[0]
const originalGetProvider = connector.getProvider.bind(connector)
connector.getProvider = async args => {
  const original = await originalGetProvider(args)
  return { ...original, request: async (args: { method: string; params?: unknown[] }) => {
  state.requests.push(structuredClone(args))
  if (args.method === 'eth_accounts') return [selectedAccount]
  if (args.method === 'eth_getTransactionCount' && args.params?.[1] === 'pending' && state.walletReadFailure) {
    if (state.walletReadFailure === 'malformed') return { result: '0x7' }
    throw { code: state.walletReadFailure === 'unsupported' ? -32601 : 4100, message: 'SECRET-PROVIDER-DETAILS' }
  }
  if (args.method === 'eth_getTransactionCount' && args.params?.[1] === 'pending' && state.numericPending) return state.walletPendingNonce
  if (args.method === 'eth_getTransactionCount') return toHex(args.params?.[1] === 'pending' ? state.walletPendingNonce : state.walletLatestNonce)
  if (args.method !== 'eth_sendTransaction') return original.request(args as never)
  state.tx = structuredClone(args.params![0])
  state.hash = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
  if (state.walletMode === 'reject') throw Object.assign(new Error('synthetic-private-error'), { code: 4001 })
  if (state.walletMode === 'unknown') throw new Error('synthetic-private-error')
  if (state.walletMode === 'held') return new Promise<string>(resolve => { release = resolve })
  return state.hash
  } }
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
Object.assign(window, { executionUiTest: { state,
  connect: (chainId = 5042) => connect(config, { connector, chainId }), disconnect: () => disconnect(config),
  chain: (chainId: number) => switchChain(config, { chainId }), account: (change: boolean) => { selectedAccount = change ? other : owner; connector.onAccountsChanged([selectedAccount]) },
  releaseBalance: () => { for (const resolve of pendingBalances.splice(0)) resolve(toHex(100n * 10n ** 18n)) },
  release: () => { release?.(state.hash); release = undefined },
} })
createRoot(document.getElementById('root')!).render(<WagmiProvider config={config}><QueryClientProvider client={queryClient}><MainnetSwapScreen /></QueryClientProvider></WagmiProvider>)
