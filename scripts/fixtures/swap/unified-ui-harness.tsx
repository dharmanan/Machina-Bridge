// Test-only EIP-1193 provider and wagmi reads. Disposable public test-key signatures only; no real wallet, external RPC or broadcast.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig } from 'wagmi'
import { mock, connect, disconnect, switchChain } from '@wagmi/core'
import { custom, defineChain, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import MainnetSwapScreen from '../../../src/components/MainnetSwapScreen'
import '../../../src/index.css'

const testAccount = privateKeyToAccount(('0x' + '00'.repeat(31) + '01') as `0x${string}`) // public test-only key; never funded or broadcast
const owner = testAccount.address
const other = '0x2222222222222222222222222222222222222222' as const
const TOKENS: Record<string, string> = {
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC', '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': 'cirBTC', '0x128cc466b61f542da60c70e3aa11c10e19b84edb': 'WETH', '0x3600000000000000000000000000000000000000': 'USDC',
}
const state = {
  signs: [] as unknown[], permitMode: 'sign', walletMode: 'hash', requests: [] as { method: string; params?: unknown[] }[], sent: [] as { tx: Record<string, string>; hash: string }[], hash: '',
  nativeBalance: 100n * 10n ** 18n, balances: { EURC: 50_000_000n, cirBTC: 10_000_000n, WETH: 10n ** 18n } as Record<string, bigint>, walletNonce: 7,
}
let releasePermit: (() => void) | undefined
let release: ((value: string) => void) | undefined
let selectedAccount: string = owner
const arc = defineChain({ id: 5042, name: 'Arc test double', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1/never-rpc'] } } })
const wrong = defineChain({ ...arc, id: 1, name: 'Wrong network test double' })
const transport = custom({ request: async args => {
  if (args.method === 'eth_getBalance') return toHex(state.nativeBalance)
  if (args.method === 'eth_chainId') return '0x13b2'
  if (args.method === 'eth_call') {
    const to = String((args.params as { to?: string }[])[0]?.to ?? '').toLowerCase(), symbol = TOKENS[to]
    return toHex(symbol === 'USDC' ? state.nativeBalance / 10n ** 12n : state.balances[symbol] ?? 0n, { size: 32 })
  }
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
    if (args.method === 'eth_getTransactionCount') return toHex(state.walletNonce)
    if (args.method === 'eth_signTypedData_v4') { state.signs.push(structuredClone(args.params)); const typed = JSON.parse(String(args.params?.[1])); if (typed.primaryType === 'PermitSingle' && state.permitMode === 'held') await new Promise<void>(resolve => { releasePermit = resolve }); return typed.primaryType === 'PermitSingle' ? testAccount.signTypedData(typed) : `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` }
    if (args.method !== 'eth_sendTransaction') return original.request(args as never)
    const tx = structuredClone(args.params![0]) as Record<string, string>
    state.hash = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
    state.sent.push({ tx, hash: state.hash })
    if (state.walletMode === 'reject') throw Object.assign(new Error('synthetic-private-error'), { code: 4001 })
    if (state.walletMode === 'unknown') throw new Error('synthetic-private-error')
    if (state.walletMode === 'held') return new Promise<string>(resolve => { release = resolve })
    return state.hash
  } }
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
Object.assign(window, { swapUiTest: { state,
  connect: (chainId = 5042) => connect(config, { connector, chainId }), disconnect: () => disconnect(config),
  chain: (chainId: number) => switchChain(config, { chainId }), account: (change: boolean) => { selectedAccount = change ? other : owner; connector.onAccountsChanged([selectedAccount]) },
  release: () => { release?.(state.hash); release = undefined },
  releasePermit: () => { releasePermit?.(); releasePermit = undefined },
} })
createRoot(document.getElementById('root')!).render(<WagmiProvider config={config}><QueryClientProvider client={queryClient}><MainnetSwapScreen /></QueryClientProvider></WagmiProvider>)
