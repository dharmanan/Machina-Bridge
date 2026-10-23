import { createWalletClient, custom, defineChain, type EIP1193Provider, type Hex } from 'viem'
import type { CircleInnerWallet } from './circleGuard'

// The wallet BELOW the guard: a viem WalletClient over the connected EIP-1193 provider. It is only ever reached through circleGuard, which has
// already decided what may be sent or signed. This module adds one more limit of its own: the provider can be asked for exactly these four
// things, and viem's habit of retrying or falling back to another method name (it tries `wallet_sendTransaction` when `eth_sendTransaction`
// fails with a few error codes, some of which mean the first request may already have been broadcast) is switched off.
export const CIRCLE_WALLET_METHODS = ['eth_chainId', 'eth_accounts', 'eth_sendTransaction', 'eth_signTypedData_v4'] as const
const arcChain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } })

export function viemInnerWallet(provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> }, owner: Hex): CircleInnerWallet {
  const transport = custom(provider as unknown as EIP1193Provider, { retryCount: 0, methods: { include: [...CIRCLE_WALLET_METHODS] } })
  const client = createWalletClient({ account: owner, chain: arcChain, transport })
  return { getChainId: () => client.getChainId(), getAddresses: () => client.getAddresses(), sendTransaction: params => client.sendTransaction(params as never), signTypedData: params => client.signTypedData(params as never) }
}
