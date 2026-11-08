# Risk disclosure

Read this before using Machina Bridge on mainnet. It explains what can go wrong in plain terms, so you can decide with real information.

## Mainnet transactions use real funds and cannot be reversed

Bridge, Swap and Earn on mainnet move real assets. Once your wallet signs and the network confirms a transaction, nobody can reverse it: not Machina, not Circle, not the network. There is no support line that can return funds.

## Machina never holds your funds

Machina has no smart contract of its own on mainnet and never takes custody of your assets. Every transaction is signed by **your own wallet**, and assets move through third-party contracts: Circle CCTP, Uniswap, Circle Swap Kit, and the Earn vaults.

This means Machina cannot freeze, recover or return funds, and cannot recover a lost seed phrase or private key. Keep your wallet secure, and never share a seed phrase or private key with anyone, including anyone who says they are from Machina.

## Check the network, amount and recipient

Mainnet and testnet are different networks. Funds sent on the wrong network, or to a wrong address, cannot be recovered. Before you sign, check the network, the amount, the recipient and the fees, both in Machina and in your wallet.

## Third-party protocols

Machina relies on independent protocols that it does not operate:

- **Circle CCTP** moves USDC between networks. A transfer depends on Circle's contracts and attestation service. If that service is slow or unavailable, a transfer can take longer to complete. An unfinished transfer can be completed later without burning again.
- **Uniswap and Circle Swap Kit** execute swaps. Prices can change between the quote and the transaction. Machina limits slippage and the size of each swap, but cannot guarantee the final price.
- **Earn vaults** are run by third-party curators. Returns are variable and not guaranteed. Withdrawals can be delayed or limited while vault funds are lent out. Vault contracts and markets carry their own smart-contract, market and liquidity risks.

Machina checks the transactions it prepares before your wallet signs them, but it cannot guarantee the security or availability of these protocols.

## Solana transfers

- A Solana → Arc transfer pays about **0.0039 SOL** for a temporary Circle account, in addition to network fees. After Circle's five-day window, the same wallet can reclaim this deposit from Machina.
- Phantom adds its own safety checks to Solana transactions. In rare cases these checks make a transfer fail on chain. **No USDC moves when this happens**; only a small network fee is lost, and you can try again. Confirm promptly when the Phantom window opens.

## Public Beta

Machina Bridge is a Public Beta built by an independent developer. It has **not** had an independent security audit. Features, supported routes and limits can change. The current security status, including known limitations, is published in [docs/SECURITY_STATUS.md](docs/SECURITY_STATUS.md).

## No advice

Nothing in Machina is investment, financial, legal or tax advice. APYs, prices and market data are shown as information. Decide for yourself, and only use funds you can afford to lose.

## Testnet

Testnet tokens have no monetary value. Never buy, sell or treat them as if they had real value.
