import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'
import { formatUnits } from 'viem'
import { SUI_NETWORKS, type SuiNetwork } from '../config/sui'

// SIP-58: total balance is not the sum of Coin objects alone. Keep both models
// visible and verify their sum before displaying a spendable balance.
export function parseSuiBalance(value: { coinType: string; balance: string; coinBalance: string; addressBalance: string }, coinType: string) {
  if (normalizeStructTag(value.coinType) !== normalizeStructTag(coinType)) throw new Error('Sui RPC returned another token.')
  const fields = [value.balance, value.coinBalance, value.addressBalance]
  if (!fields.every(x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && x.length <= 78)) throw new Error('Invalid Sui balance response.')
  const [total, coins, address] = fields.map(BigInt)
  if (total !== coins + address) throw new Error('Sui address and coin balances do not reconcile.')
  return { total, coins, address }
}

export function validateSuiWalletAccount(account: { address: string; chains: readonly string[] } | null, network: SuiNetwork) {
  if (!account || !/^0x[0-9a-f]{64}$/i.test(account.address) || /^0x0{64}$/i.test(account.address)) throw new Error('Connect a valid Sui wallet account.')
  if (!account.chains.includes(`sui:${network}`)) throw new Error(`This wallet account does not support Sui ${network}.`)
  return normalizeSuiAddress(account.address)
}

export async function readSuiWalletBalances(client: {
  getChainIdentifier: (input?: { signal?: AbortSignal }) => Promise<{ chainIdentifier: string }>
  getBalance: (input: { owner: string; coinType: string; signal?: AbortSignal }) => Promise<{ balance: { coinType: string; balance: string; coinBalance: string; addressBalance: string } }>
}, owner: string, network: SuiNetwork, signal?: AbortSignal) {
  // gRPC reports the full genesis digest. A selected UI network alone is not
  // evidence that the RPC really serves that network. No latest/testnet fallback.
  const observed = await client.getChainIdentifier({ signal })
  if (observed.chainIdentifier !== SUI_NETWORKS[network].chainIdentifier) throw new Error('Sui RPC network identity could not be verified.')
  const usdcType = SUI_NETWORKS[network].usdcCoinType
  const [usdc, sui] = await Promise.all([
    client.getBalance({ owner, coinType: usdcType, signal }),
    client.getBalance({ owner, coinType: '0x2::sui::SUI', signal }),
  ])
  const usdcBalance = parseSuiBalance(usdc.balance, usdcType)
  const suiBalance = parseSuiBalance(sui.balance, '0x2::sui::SUI')
  return { usdc: usdcBalance, sui: suiBalance, usdcDisplay: formatUnits(usdcBalance.total, 6), suiDisplay: formatUnits(suiBalance.total, 9) }
}
