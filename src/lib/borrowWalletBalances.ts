import { createPublicClient, http, parseAbi, type Hex } from 'viem'
import { MAINNET_BORROW_CHAIN_ID } from '../config/mainnetBorrow'

// Read-only wallet balances for the Borrow preview: the native gas balance and the balance of the market's two tokens, through
// view calls on the public Arc RPC (the same RPC and the same pattern as the market check and the Earn and Dashboard
// balances). No wallet request, signature or transaction. A balance that cannot be read is null, never zero.

export type WalletBalances = {
  native: bigint | null
  loanToken: { address: string; raw: bigint | null }
  collateralToken: { address: string; raw: bigint | null }
}

export type WalletBalanceReader = (owner: string, loanToken: string, collateralToken: string) => Promise<WalletBalances>

const ERC20 = parseAbi(['function balanceOf(address account) view returns (uint256)'])

export function createViemBalanceReader(rpcUrl: string): WalletBalanceReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) })
  return async (owner, loanToken, collateralToken) => {
    const nothing: WalletBalances = { native: null, loanToken: { address: loanToken, raw: null }, collateralToken: { address: collateralToken, raw: null } }
    // The chain ID is checked before any answer is trusted, as for the market check.
    const chainId = await client.getChainId().catch(() => null)
    if (chainId !== MAINNET_BORROW_CHAIN_ID) return nothing
    const token = (address: string) => client.readContract({ address: address as Hex, abi: ERC20, functionName: 'balanceOf', args: [owner as Hex] }).catch(() => null)
    const [native, loan, collateral] = await Promise.all([
      client.getBalance({ address: owner as Hex }).catch(() => null),
      token(loanToken),
      token(collateralToken),
    ])
    return { native, loanToken: { address: loanToken, raw: loan }, collateralToken: { address: collateralToken, raw: collateral } }
  }
}
