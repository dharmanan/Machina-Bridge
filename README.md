# Machina Bridge

**Arc DeFi, cross-chain USDC transfers, and on-chain intelligence.**

Machina Bridge is an independent, community-built interface for exploring activity on Arc and using supported blockchain and DeFi services. The application is available as a **Public Beta**.

**[Launch Machina Bridge](https://www.machinabridge.xyz/)** · [Arc documentation](https://docs.arc.network/)

## Features

| Feature | What it does | Availability |
| --- | --- | --- |
| **Arc Intelligence** | Explore Arc network activity, DEX markets, token discovery, lending activity, and cross-chain observations. | Mainnet · Read-only Beta |
| **Bridge** | Transfer USDC between Arc and supported Ethereum, Base, OP Mainnet, Arbitrum, and Solana routes. | Mainnet · Wallet-confirmed transactions |
| **Earn** | Explore selected Arc USDC vaults and request deposits or withdrawals through Circle Earn Kit. | Mainnet · Supported vaults |
| **Borrow** | View Morpho cirBTC-collateral / USDC-loan markets, price a borrow with Circle Borrow Kit quotes, and review a wallet's existing loans. | Mainnet · **Read-only Preview** |
| **Swap** | Swap test assets using the Ethereum Sepolia interface. | **Testnet only** |

The app also includes a separate testnet experience for development and experimentation. **Mainnet Gateway forwarding is not enabled.** Availability, supported routes, market terms, and liquidity may change.

## Arc Intelligence

Arc Intelligence provides an overview of supported activity on the Arc network:

- **Network:** transactions, blocks, gas usage, activity trends, and available unique-address metrics.
- **DEX:** Uniswap V3/V4 swaps, trading volume, pool activity, and available liquidity data.
- **Tokens and protocols:** observed contract and token activity, selected lending protocols, and other supported ecosystem data.
- **Cross-chain activity:** observations from supported bridging and interoperability protocols.
- **Wallet activity:** balances and supported transfer or Earn activity associated with the connected wallet.

Select **24H**, **7D**, or **30D** to explore available history. Metrics can have different coverage; a missing or incomplete value is not presented as a confirmed zero. Historical address counts or asset valuations may be unavailable when supporting data is insufficient.

**DEX pool trading fees are not Arc network gas fees.** Where displayed, pool fees are estimates and their calculation coverage is identified.

Intelligence is informational. It does not provide investment recommendations or automatically execute transactions. Observed contracts, pools, and protocol activity should not be mistaken for endorsement or proof of asset safety.

## Bridge

Machina supports wallet-signed USDC transfers through Circle CCTP on configured Arc mainnet routes:

- Arc ↔ Ethereum
- Arc ↔ Base
- Arc ↔ OP Mainnet
- Arc ↔ Arbitrum One
- Arc ↔ Solana

The interface provides available route and fee information before wallet confirmation, transaction references, and transfer-status tracking. Supported pending transfers can expose recovery or completion actions when applicable. A configured route does not guarantee that every transfer will be available or complete immediately.

For some Solana transfers, temporary accounts can require SOL deposits in addition to ordinary network fees. When eligible, a refundable deposit can be reclaimed through the available wallet flow. Refund eligibility is determined by the actual on-chain state.

**Always review the network, amount, recipient, fees, and wallet confirmation before sending funds.**

## Earn

Earn uses Circle Earn Kit for selected USDC vaults on Arc Mainnet, including **Galaxy USDC** and **Gauntlet USDC Prime** in the current configuration.

Users can view available vault information, review an operation quote, and submit supported deposit or withdrawal transactions with their wallets. APY, fees, liquidity, and availability are dynamic and must be checked at the time of an action.

Vaults are operated by third parties. Yields are not guaranteed, and funds remain exposed to smart-contract, market, liquidity, and protocol risks.

## Borrow Preview

The Borrow tab shows the **Morpho cirBTC / USDC** markets on Arc through Circle Borrow Kit, with Borrow APY, liquidation LTV, utilization, and available liquidity for each market. Each market is also checked against Morpho Blue on Arc: its ID must hash from the on-chain parameters, and the tokens and LLTV must match Circle's data; the oracle and rate model shown are read from those same parameters. A market that cannot be checked is labelled **Not verified** and is never shown as verified. Market cards show the asset pair, Borrow APY, available liquidity, LLTV and short status labels as facts, not advice; the market ID, oracle, rate model and checks are under **Market details**, and markets are never ranked or recommended.

The screen keeps three things apart. **Your loans** is the connected wallet's current position from the Borrow Service: each loan shows its own collateral, debt, interest, LTV, Current Health Factor and liquidation price, no wallet-wide Health Factor is ever computed, and "No active loan" (with Current Health Factor "Not applicable") is only said after a complete, successful read; a failed read says "Unavailable". **New borrow estimate** is a quote for the amount you type: Borrow Amount, Collateral Required (sized by the Borrow Service), Borrow APY, Estimated Gas / Fees, **Estimated Health Factor** (for this borrow, not your current loan), **Target Health Factor** (your selection) and Liquidation Price. Your wallet's real cirBTC balance is read on-chain and shown separately; the optional collateral comparison is a typed number, collapsed, and changes nothing else.

**Transaction readiness** runs the shared safety checks in [`src/lib/borrowWriteSafety.ts`](src/lib/borrowWriteSafety.ts) and reads **Ready for review**, **Blocked** or **Unavailable**. They are the same checks the write boundary in [`src/lib/mainnetBorrow.ts`](src/lib/mainnetBorrow.ts) runs again, on fresh reads, before any future write: Arc mainnet (chain 5042), an EIP-5792 atomic-batch wallet (no separate-transaction fallback), a wallet session that is dropped when the wallet or network changes, a quote that is fresh (60 s), bound to its market or loan, wallet, amount and slippage, and unchanged since review, the market verified on-chain, a readable oracle, liquidity and balances compared exactly in token units, the pinned Circle Borrow Adapter address, and a 70% loan-to-value limit. A quote whose Health Factor is below your selected target (for example 1.24 against 1.50) is **Selected safety target not met** and blocks; Machina does not prepare a transaction with different collateral. Health Factor and LTV are compared as the raw numbers the service reports, never the rounded ones on screen. Repay and Add collateral are not held to the new-borrow limits; Withdraw collateral must still meet your Health Factor target, and Close loan must cover the whole debt with its interest. Missing, stale or unverifiable data is "Unavailable" and blocks. **Ready for review does not mean a transaction can be sent**: the write gate is a separate, closed switch. The technical checks are behind **Show technical checks**. `node scripts/verify-mainnet-borrow-markets-onchain.mjs` repeats the on-chain market check from the command line.

Anything the Borrow Service does not report is shown as "Not reported" rather than estimated. The borrow rate is variable, and a position can be liquidated when its health factor falls below 1.0; the tab states both risks.

**Borrow transactions are not enabled.** The tab never asks a wallet to sign, approve a token, or send a transaction (its one wallet question is the read-only `wallet_getCapabilities`), and its action buttons are permanently disabled. Transaction functionality will require a separately reviewed release; read-only quotes do not imply that borrowing is live.

The current source-level control is defined in [`src/config/mainnetBorrow.ts`](src/config/mainnetBorrow.ts).

## Fees and data transparency

Machina currently displays no additional Machina service commission for its supported transaction flows. **That does not make transactions free:** blockchain gas, Circle or other protocol fees, and any applicable Solana account costs may still apply. Confirm current amounts in the interface before signing.

Arc Intelligence reports supported observations and labels unavailable or incomplete data. Figures reflect the sources and periods covered, not necessarily every contract or transaction in the ecosystem. Historical coverage and available metrics may change as the Beta evolves.

Transactions involving real assets are irreversible and carry financial risks. Use a wallet you control and never share a seed phrase or private key.

## Technology and architecture

- **Frontend:** React, TypeScript, Vite, Wagmi, RainbowKit, and Solana wallet integration.
- **Blockchain integrations:** Circle CCTP / Bridge Kit, Earn Kit, Borrow Kit market reads, and supported Arc DeFi protocols.
- **Hosting:** Vercel for the web application and same-origin API proxies.
- **Arc Intelligence service:** Node.js on Railway with a compact, SQLite-backed collection and read-model pipeline.

Main code locations:

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | Application UI, wallet flows, and client logic |
| [`src/config/`](src/config/) | Networks, capabilities, and feature controls |
| [`api/`](api/) | Web API handlers and read-only proxies |
| [`server/compact/`](server/compact/) | Intelligence collection and read models |
| [`scripts/`](scripts/) | Local verification and developer utilities |

Implementation details and evolving data definitions live in the source code. The public README describes product capabilities, not the current operational health or an independent security audit.

## Run locally

**Requirements:** Node.js 24.x and npm. A compatible wallet is needed only for flows that require wallet interaction.

```bash
git clone https://github.com/dharmanan/Machina-Bridge.git
cd Machina-Bridge
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

Available local checks include:

```bash
npm run verify:arc-dashboard
npm run lint
```

These commands are development checks, **not** proof of a successful mainnet transaction or a security audit. The live Intelligence service and some features depend on configured external endpoints and service availability.

Environment variables vary by deployment. Browser variables prefixed with `VITE_` are exposed to the frontend: **never put API secrets, private keys, or wallet recovery phrases in them**. See [`src/config/`](src/config/) for network-related configuration.

## Independence, security, and license

Machina Bridge is an independent project, **not an official Arc, Circle, Uniswap, or Morpho product**. Protocol integrations do not constitute endorsements, investment advice, or guarantees of funds or returns.

- [Live application](https://www.machinabridge.xyz/)
- [Source code](https://github.com/dharmanan/Machina-Bridge)
- [Security contact](https://www.machinabridge.xyz/.well-known/security.txt)
- [Arc Explorer](https://explorer.arc.io)
- [X](https://x.com/KohenEric)

Licensed under the [MIT License](LICENSE).
