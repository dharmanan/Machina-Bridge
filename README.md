# Machina Bridge

**Cross-chain USDC transfers, Arc swaps, Earn vaults and wallet tracking in one app.**

Machina Bridge is an independent, community-built interface for supported Arc blockchain and DeFi services. The application is available as a **Public Beta**. It runs on mainnet with real funds and has **not** had an independent security audit; see [Security](#independence-security-and-license).

**[Launch Machina Bridge](https://www.machinabridge.xyz/)** · [Arc documentation](https://docs.arc.network/) · [Security status](docs/SECURITY_STATUS.md) · [Risks](RISK.md) · [Privacy](PRIVACY.md)

## Features

| Feature | What it does | Availability |
| --- | --- | --- |
| **Bridge** | USDC between Arc and Ethereum, Base, OP Mainnet, Arbitrum One, Solana and Sui via Circle CCTP, with status tracking and recovery of unfinished transfers. | Mainnet · Wallet-confirmed transactions |
| **Dashboard** | USDC balances across connected wallets, bridge transactions, and Solana refundable SOL deposits with reclaim. | Mainnet |
| **Swap** | USDC, EURC, cirBTC and WETH on Arc through Uniswap or Circle Swap Kit, with per-swap ceilings. | Mainnet · Supported routes |
| **Earn** | Selected Arc USDC vaults through Circle Earn Kit: deposit and withdraw. | Mainnet · Supported vaults |
| **Activity** | Recent Arc wallet transactions and transfers reported by Blockscout. Solana and Sui activity is not listed. | Mainnet · Read-only |
| **Testnet** | A separate testnet interface with a faucet and a testnet swap. | **Testnet only** |
| **Borrow** | Experimental Morpho borrowing preview, retained in the source and removed from the public navigation. | **Paused** |

**Mainnet Gateway forwarding is not enabled.** Availability, supported routes, market terms and liquidity may change.

Supported wallets: EVM wallets through RainbowKit (for example MetaMask), Phantom for Solana, and Sui wallets such as Slush.

## Bridge

Machina supports wallet-signed USDC transfers through Circle CCTP V2 on these Arc mainnet routes:

- Arc ↔ Ethereum
- Arc ↔ Base
- Arc ↔ OP Mainnet
- Arc ↔ Arbitrum One
- Arc ↔ Solana
- Arc ↔ Sui

Before your wallet is asked to sign, Machina shows the route, the fees and the amount you receive, and **checks the transaction independently**. Whether Machina builds a transaction itself or Circle Bridge Kit builds it, the program or contract, function, amount, recipient and fee bound are verified first. A transaction that fails a check is never sent to the wallet. Only one burn can be signed per transfer, and a transfer whose outcome is unknown is settled from chain data before anything else is sent. Unfinished transfers can be recovered in the app without burning again.

**Solana deposits.** A Solana → Arc transfer creates a temporary Circle account that holds about 0.0039 SOL rent in addition to network fees. After Circle's five-day window, the same Phantom wallet can reclaim it from the Bridge or the Dashboard. Machina finds open deposits on chain, so they also appear in another browser. Eligibility is determined by the actual on-chain state.

**Phantom notice.** Phantom adds its own Lighthouse safety checks to Solana transactions. One of them pins the USDC mint account, so a burn confirmed slowly can fail on chain. No USDC moves when this happens and the app says you can try again. Confirm promptly when the Phantom window opens.

**Always review the network, amount, recipient, fees, and wallet confirmation before sending funds.**

## Swap

Swap covers four Arc mainnet tokens (USDC, EURC, cirBTC, WETH) in every direction, through two providers: Uniswap and Circle Swap Kit. Quotes expire after 30 seconds. Slippage can be set to 0.5%, 1% or 3%. Each swap is capped at roughly 10 USD per token. Tokens, routers and spenders are pinned in the source. See [`docs/swap-unified.md`](docs/swap-unified.md).

## Earn

Earn uses Circle Earn Kit for selected USDC vaults on Arc Mainnet, including **Galaxy USDC** and **Gauntlet USDC Prime** in the current configuration.

Users can view available vault information, review an operation quote, and submit supported deposit or withdrawal transactions with their wallets. APY, fees, liquidity, and availability are dynamic and must be checked at the time of an action.

Vaults are operated by third parties. Yields are not guaranteed, and funds remain exposed to smart-contract, market, liquidity, and protocol risks.

## Borrow Preview

**Borrow is paused and is not available in the public navigation.** The archived component shows the Morpho cirBTC / USDC markets on Arc through Circle Borrow Kit. It verifies each market against Morpho Blue on chain and runs the same safety checks a future write would use. **Borrow transactions are not enabled.** The tab never asks a wallet to sign, approve a token, or send a transaction; its only wallet question is the read-only `wallet_getCapabilities`. Enabling writes would require a separately reviewed release. The source-level control is in [`src/config/mainnetBorrow.ts`](src/config/mainnetBorrow.ts).

## Arc Intelligence

Arc Intelligence was an experimental Arc network, DEX, lending and cross-chain analytics service. It has been **retired from the public application**. Its source code and validation scripts remain in this repository for reference only. Any archived data is informational and does not provide investment recommendations; a missing or incomplete value is not presented as a confirmed zero. This is not a live data product.

## Fees and data transparency

Machina currently charges no service commission on its supported transaction flows. **That does not make transactions free:** blockchain gas, Circle or other protocol fees, and Solana account deposits may still apply. Confirm current amounts in the interface before signing.

Machina keeps no server-side database of user transfers. Transfer, recovery and testnet history stay in your browser; chain data is read through public RPCs, Circle's attestation service and Blockscout, using same-origin proxies where needed.

Transactions involving real assets are irreversible and carry financial risks. Use a wallet you control and never share a seed phrase or private key. Read the [risk disclosure](RISK.md) and the [privacy notes](PRIVACY.md) before using mainnet.

## Technology and architecture

- **Frontend:** React, TypeScript, Vite, Wagmi, RainbowKit, Solana web3.js and Sui dApp Kit.
- **Integrations:** Circle CCTP V2 / Bridge Kit, Earn Kit, Swap Kit, Uniswap on Arc, and Borrow Kit market reads.
- **Hosting:** Vercel for the web app and same-origin API proxies. No Redis, database or Railway dependency for live flows.
- **Supply chain:** installs run `npm ci --ignore-scripts` from the lockfile; SDK telemetry is disabled where supported; third-party responses are size-limited.

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | Application UI, wallet flows and client logic |
| [`src/lib/`](src/lib/) | Transaction policies, send guards, recovery and chain reads |
| [`src/config/`](src/config/) | Networks, pinned contracts and feature controls |
| [`api/`](api/) | Same-origin API handlers and read-only proxies |
| [`scripts/`](scripts/) | Verification suites and developer utilities |
| [`docs/`](docs/) | Security status, dependency review and design notes |
| [`server/`](server/) | Retired Arc Intelligence source, for reference only |

## Run locally

**Requirements:** Node.js 24.x and npm. A compatible wallet is needed only for flows that require wallet interaction.

```bash
git clone https://github.com/dharmanan/Machina-Bridge.git
cd Machina-Bridge
npm install
npm run dev
```

Create a production build (it also runs the TypeScript check):

```bash
npm run build
```

Run the lint and the verification suites used by CI:

```bash
npm run lint
```

```bash
node scripts/run-suites.mjs fast
```

```bash
node scripts/run-suites.mjs full
```

These suites include negative tests: refused transactions never reach the wallet, and second burns are blocked. They are development checks, **not** proof of a successful mainnet transaction or a security audit, and they never send real transactions.

Browser variables prefixed with `VITE_` are exposed to the frontend: **never put API secrets, private keys, or wallet recovery phrases in them**. See [`src/config/`](src/config/) for network configuration.

## Independence, security, and license

Machina Bridge is an independent project, **not an official Arc, Circle, Uniswap, or Morpho product**. Protocol integrations do not constitute endorsements, investment advice, or guarantees of funds or returns.

**Security.** [docs/SECURITY_STATUS.md](docs/SECURITY_STATUS.md) lists what Machina verifies before signing, what it trusts without verifying, and its known limitations. Machina does not claim to be free of vulnerabilities. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

- [Live application](https://www.machinabridge.xyz/)
- [Source code](https://github.com/dharmanan/Machina-Bridge)
- [Security contact](https://www.machinabridge.xyz/.well-known/security.txt)
- [Arc Explorer](https://explorer.arc.io)
- [X](https://x.com/KohenEric)

Licensed under the [MIT License](LICENSE).
