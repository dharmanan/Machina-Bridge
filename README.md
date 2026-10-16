# Machina Bridge — Public Beta

**Machina Bridge is an independent Arc DeFi platform combining verifiable on-chain intelligence with supported cross-chain and DeFi transactions.**

[Live App](https://www.machinabridge.xyz/) · [Repository](https://github.com/dharmanan/Machina-Bridge)

Public Beta is live. Mainnet is the default for users without a saved network preference; Testnet remains a separate profile. The Mainnet Dashboard is labeled **Beta**. Available features and verified data coverage differ by section.

## Product Overview

Use Arc Intelligence to inspect stored, verified Arc activity, Bridge to transfer USDC across supported routes, and Earn to manage supported Arc USDC vault positions. These are separate surfaces in one application: analytics do not automatically recommend or execute a transaction. Borrow is a read-only market preview, while Swap is a separate testnet tool.

Machina does not provide automated investment advice, trading signals, one-click analysis-to-trade execution, or complete Arc ecosystem coverage.

## Current Features and Availability

| Surface | Network | Availability | User actions |
| --- | --- | --- | --- |
| Bridge | Arc and supported EVM mainnets; Solana Mainnet | Active on verified routes | Review fees, sign USDC transfers, track and resume supported pending transfers |
| Earn | Arc Mainnet | Active for selected USDC vaults | Review quotes, deposit and withdraw using a wallet |
| Intelligence | Arc Mainnet | Read-only analytics in the Beta Dashboard | Inspect available verified 24H, 7D and 30D data; coverage is explicit |
| Borrow | Arc Mainnet | Read-only Preview | View cirBTC/USDC Morpho markets and available terms; no wallet action |
| Swap | Ethereum Sepolia | Testnet-only | ETH/USDC swaps through Uniswap V2 |
| Mainnet Gateway forwarding | Mainnet | Disabled | No mainnet forwarding action |

An analytics entry for a protocol does not imply that Machina offers transactions for that protocol. A verified pool or launch event also does not prove a token's identity or investment quality.

## Arc Intelligence

The Dashboard separates supported, verified observations from missing coverage and sources that are not yet tracked:

- **Network Activity:** blocks, transactions, gas used, TPS, exact unique active addresses when identity evidence is complete, and hourly or completed UTC-day charts.
- **Uniswap V3/V4:** verified pool discovery, swaps, liquidity events, pool rankings, USD volume, estimated pool fees and available pool-state valuations. Pool rankings are labeled by swap count; volume is shown separately.
- **Tokens and launches:** discovered contract records, creation and launch evidence, pools and observed versus proven first DEX activity. Lists are paginated and capped; returned rows are not a total ecosystem launch count. Contract metadata alone is not a verified token identity.
- **Lending:** available Aave V4, Morpho Blue and Morpho Vaults V2 events, amounts and per-action USD coverage.
- **Cross-chain:** observed Arc-side CCTP, Gateway and Across activity with explicit token and source verification. Analytics for Gateway are distinct from disabled mainnet Gateway forwarding.
- **Assets and ecosystem:** supported verified asset transfers, available prices, USYC/RWA observations and bounded protocol-specific activity, including tracked Archery CL pools where covered. Other DEX/protocol, asset and exchange-flow fields remain explicit when a verified source is absent.
- **Wallet activity:** separate Dashboard and Activity views show connected-wallet balances, supported bridge/Earn activity and Solana deposit tracking. This wallet-scoped view is separate from network-wide Intelligence statistics.

The stable UI scope is declared in [`src/config/arcIntelligenceUiScope.ts`](src/config/arcIntelligenceUiScope.ts). A scope slot is a product requirement, not proof that all of its data is available. Runtime validation and coverage determine whether a value can be shown.

## Data Integrity and Limitations

- **24H, 7D and 30D** correspond to 24, 168 and 720 hourly intervals. Available verified history within 30D is shown with actual coverage and dates; a partial total is not a completed 30-day total. Coverage and availability can differ between metrics.
- **Unique addresses require identities.** 7D and 30D counts use exact unions when the necessary identity sets are verified. Daily unique counts are never added together to invent a window count. Historical identity gaps currently leave the 30D metric **Not verified**, with an unavailable/null API value; other verified metrics can remain visible.
- **Missing is not zero.** Missing hours, unverified prices, incomplete discovery evidence and unsupported sources stay explicit. Complete UTC-day charts and partial intervals retain their own coverage semantics.
- **Prices and USD amounts are conditional.** USDC valuation follows the documented USD anchor; other supported assets require verified hourly Arc price evidence. Missing prices are not estimated or silently treated as zero. Swap counts, valued subsets and excluded swaps remain distinct.
- **Pool values are dated.** V3 token balances and V4 estimated principal reserves come from verified pool state at the reported snapshot block. V4 estimates exclude uncollected fees and position rounding; unsupported hooks can prevent valuation. Estimated pool fees are not Arc gas fees.
- **Financial actions remain separate.** Lending supply, withdrawal, borrow, repayment and bridge actions are not summed into one misleading comparable volume.
- **Snapshots can lag.** 30D Summary, V3, V4 and Ecosystem share one verified checkpoint. A retained compatible snapshot reports its real checkpoint and delay. Without a valid snapshot these sections remain not ready; there is no heavy 30D calculation fallback in the HTTP request.
- **Beta is not a completeness or audit claim.** Source definitions, checksums and strict parsers protect supported observations, but do not establish full ecosystem coverage or guarantee API uptime. Transaction success-rate analytics requiring receipts are not offered.

## Borrow Preview

Borrow uses **Circle Borrow Kit** via a read-only proxy to display supported **cirBTC collateral / USDC loan Morpho markets on Arc**. Available fields include market identifiers, Borrow APY, liquidation LTV, utilization and liquidity. Missing terms remain unavailable; markets are listed by ID, not ranked or recommended.

`MAINNET_BORROW_WRITES_ENABLED=false` remains a source-level lock. No Borrow wallet action or transaction route is exposed. The presence of guarded SDK write helpers does not enable borrowing, repayment, or collateral management in the product. Read-only market discovery does not require a wallet signature.

## Bridge and Earn

### Mainnet Routes

The following routes are enabled and marked verified in the application:

| Feature | Route | Asset | Status |
| --- | --- | --- | --- |
| EVM Bridge | Arc ↔ Base | USDC | Verified |
| EVM Bridge | Arc ↔ Ethereum | USDC | Verified |
| EVM Bridge | Arc ↔ Optimism | USDC | Verified |
| EVM Bridge | Arc ↔ Arbitrum | USDC | Verified |
| Solana Bridge | Arc ↔ Solana | USDC | Verified |

Mainnet routes use Circle CCTP and have been validated with small real-value transfers in both directions.

### Testnet Routes

Testnet remains available for experimentation and development.

| Feature | Route | Asset | Status |
| --- | --- | --- | --- |
| Swap | Ethereum Sepolia ETH ↔ USDC | ETH / USDC | Active |
| EVM Bridge | Ethereum Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Base Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Optimism Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Arbitrum Sepolia ↔ Arc Testnet | USDC | Active |
| Gateway Forwarding | Arc Testnet → Solana Devnet | USDC | Active |
| Solana Bridge | Solana Devnet → Arc Testnet | USDC | Active |

Testnet assets have no real monetary value.

### Bridge Experience

Current bridge functionality includes:

- Route-aware USDC bridging across verified Arc mainnet routes
- Circle/CCTP flows with wallet-controlled transaction signing
- Separate EVM and Solana bridge interfaces
- Live fee estimation before signing
- Source and destination transaction links
- Circle attestation tracking
- Pending-transfer recovery
- Ready-to-mint detection where applicable
- Local and server-side activity persistence
- Deduplication between local and server records
- In Progress, Ready to Mint, and Completed activity states
- Retry and recovery handling for common wallet and transaction edge cases

### Arc Mainnet Earn

Earn offers Arc Mainnet USDC deposits and withdrawals through Circle Earn Kit. The current launch vaults are **Galaxy USDC** and **Gauntlet USDC Prime**, with Morpho-backed vault exposure where applicable.

Users review a quote before confirming each deposit or withdrawal in their own wallet. **Machina fee: 0 USDC.** Network and protocol costs may still apply.

Vaults are operated by third parties. Yields vary, and DeFi, smart contract, protocol, and market risks remain. Circle Guarded does not guarantee returns or protect principal.

### Fees

Machina currently charges **no service commission**.

The interface shows:

- **Machina fee: 0 USDC**
- Circle or protocol fees where applicable
- Network fees paid to the source or destination blockchain
- Solana refundable deposits where applicable

A Machina fee of 0 USDC does **not** mean a transfer is free. Network and protocol costs may still apply.

### Solana Refundable Deposits

For a **Solana → Arc** CCTP transfer, Circle creates a temporary Solana account for that transfer.

Solana requires SOL to fund that temporary account. This amount is separate from the permanent Solana transaction fee and is not paid to Machina.

Machina Bridge therefore shows:

- the expected Phantom SOL debit
- the refundable Circle deposit
- network / priority fee information
- open refundable deposits for the connected Phantom wallet
- the remaining waiting period
- a **Return SOL** action when the deposit becomes eligible

Circle's event-account window is currently **5 days**. After that period, an eligible temporary account can be closed and its refundable SOL returned to the same Phantom wallet.

The refundable deposit panel is collapsed by default. The return flow is implemented and checks eligibility before submission. Its presence in the UI is not a guarantee that every deposit is reclaimable; live eligibility and wallet confirmation are still required. This documentation does not assert a newly completed mainnet reclaim acceptance test.

### Wallet Integrations

#### EVM

EVM wallet connections use Wagmi and RainbowKit.

Mainnet EVM networks:

- Arc
- Ethereum
- Base
- OP Mainnet
- Arbitrum One

Testnet EVM networks:

- Arc Testnet
- Ethereum Sepolia
- Base Sepolia
- Optimism Sepolia
- Arbitrum Sepolia

#### Solana

Phantom is used for Solana connection and signing.

Supported Solana environments:

- Solana Mainnet
- Solana Devnet

#### Sui

A Sui wallet connector is present in the testnet interface. There is currently no Sui bridge route exposed in the production mainnet bridge flow.

### Arc Mainnet

| Parameter | Value |
| --- | --- |
| Chain ID | `5042` |
| RPC | `https://rpc.mainnet.arc.io` |
| Gas asset | USDC |
| Native USDC | `0x3600000000000000000000000000000000000000` |
| CCTP Domain | `26` |
| TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Explorer | `https://explorer.arc.io` |
| Official docs | `https://docs.arc.network/` |

### Solana Mainnet

| Parameter | Value |
| --- | --- |
| CCTP Domain | `5` |
| USDC Mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| MessageTransmitterV2 | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| TokenMessengerMinterV2 | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| Explorer | `https://solscan.io` |

### Mainnet USDC Addresses

| Network | USDC |
| --- | --- |
| Arc | `0x3600000000000000000000000000000000000000` |
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| OP Mainnet | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

### Arc Testnet

| Parameter | Value |
| --- | --- |
| Chain ID | `5042002` |
| Default RPC | `https://rpc.testnet.arc.io` |
| Gas asset | USDC |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |

## Architecture

- **Frontend:** React/TypeScript/Vite on Vercel; Wagmi/RainbowKit for EVM wallets and Phantom for Solana signing. Testnet and mainnet interfaces remain separate.
- **Serverless reads:** same-origin Vercel Intelligence and Borrow proxies validate requests and response contracts. They do not run the hourly collector or accept Borrow writes. Transfer/activity APIs are separate from read-only analytics.
- **Intelligence backend:** the existing `server/compact` Node.js service on Railway stores canonical hours, protocol evidence, projections and read models in SQLite. Packed storage and versioned evidence are checked before use; this is not a second canonical pipeline.
- **Collection and scheduling:** the in-process scheduler prioritizes live hours and permits one scheduled child at a time. Optional maintenance/recovery work is controlled separately; code availability does not imply production activation.
- **30D publication:** after collection, the existing background child prepares Summary, V3, V4 and Ecosystem against one checkpoint. Only a complete validated bundle is atomically published to persistent storage. Failed preparation preserves the previous compatible snapshot; restart can reload it. The collector does not depend on successful snapshot publication.
- **HTTP reads:** 24H/7D pool and Ecosystem reads use the bounded read-only worker; 30D sections use persistent snapshots. Checkpoint, freshness and schema checks remain mandatory. Snapshots are read caches, not independent backups or a replacement for historical identity evidence.

Production uses `scripts/serve-compact-intelligence.mjs` as declared in `railway.toml`. The older `npm run start:intelligence` command targets `server/arc-intelligence/main.js`; it is not the current compact production entry point. Do not point development or test commands at a production database, enable recovery, or change service scheduling as part of ordinary frontend setup.

### Technology

Machina Bridge uses:

- React
- TypeScript
- Vite
- Wagmi
- Viem
- RainbowKit
- Ethers
- Circle Bridge Kit
- Circle Earn Kit
- Circle Borrow Kit (read-only market Preview)
- Morpho vault data
- Circle Solana adapter
- Solana Web3.js
- Mysten dApp Kit
- Vercel serverless APIs
- Node.js 24 and built-in SQLite for the compact Intelligence backend

### Project Structure

```text
Machina-Bridge/
├── api/
├── public/
│   ├── .well-known/
│   │   └── security.txt
│   ├── robots.txt
│   └── sitemap.xml
├── server/compact/  # SQLite collector, read models, scheduler and snapshots
├── scripts/
├── src/
│   ├── components/
│   ├── config/
│   ├── hooks/
│   ├── lib/
│   ├── App.tsx
│   └── main.tsx
├── README.md
├── package.json
├── vercel.json
└── vite.config.ts
```

## Development and Validation

### Quick Start

#### Requirements

- Node.js 24.x (validated with 24.21.0; compact tests use the built-in `node:sqlite`)
- npm
- An EVM wallet such as MetaMask or Rabby
- Phantom for Solana flows
- Native gas assets and USDC for the networks being used

#### Clone and install

```bash
git clone https://github.com/dharmanan/Machina-Bridge.git
cd Machina-Bridge
npm install
```

#### Run locally

```bash
npm run dev
```

The Vite development server normally runs on `http://localhost:3000` (it can select another port if 3000 is occupied). Intelligence and Borrow reads use the configured proxy paths; full offline data is not bundled with the frontend. Starting the UI is not a request to index or recover blockchain history.

#### Production build

```bash
npm run build
```

### Environment

The application includes public RPC fallbacks and accepts environment overrides where configured.

Common browser-side variables include:

```text
VITE_WALLETCONNECT_PROJECT_ID
VITE_CIRCLE_APP_ID

VITE_ARC_MAINNET_RPC
VITE_ARC_MAINNET_EXPLORER
VITE_ETHEREUM_MAINNET_RPC
VITE_BASE_MAINNET_RPC
VITE_OPTIMISM_MAINNET_RPC
VITE_ARBITRUM_MAINNET_RPC
VITE_SOLANA_MAINNET_RPC

VITE_SEPOLIA_RPC
VITE_ARC_TESTNET_RPC
VITE_BASE_SEPOLIA_RPC
VITE_OPTIMISM_SEPOLIA_RPC
VITE_ARBITRUM_SEPOLIA_RPC
VITE_SOLANA_DEVNET_RPC
```

Do not place private keys, wallet seed phrases, or backend secrets in `VITE_*` variables. Vite environment variables are exposed to the browser bundle.

### Validation commands

Use Node.js 24.x. The existing scripts have different scopes; none of the following is a statement that every check or a security audit has passed for a particular deployment.

| Command | Purpose and boundary |
| --- | --- |
| `npm run build` | TypeScript check and Vite production build |
| `npm run verify:arc-dashboard` | Local UI/proxy contract regressions with fixtures and test doubles; not real mainnet proof |
| `ARC_DASHBOARD_TEST_FILTER='Public Beta' npm run verify:arc-dashboard` | Focused release identity, documentation and Beta-label checks |
| `node scripts/verify-arc-intelligence-responsive.mjs` | Local Chromium/CSS responsive checks; requires a built frontend and local Chromium |
| `npm run verify:mainnet-solana-bridgekit` | Read-only SDK supported-chain check |
| `npm run verify:mainnet-cctp` | Mainnet RPC/Circle read checks and simulation; requires network access |
| `npm run verify:mainnet-solana-cctp` | Mainnet RPC/Circle read checks; requires network access |
| `npm run railway:intelligence:check` | Checks legacy server imports and bundled migration files without starting that server; not compact deployment validation |
| `npm run lint` | Configured lint command; its presence does not assert a clean lint result |
| `npm audit` / `npm audit --omit=dev` | Dependency advisories; not a smart-contract or financial security audit |

Snapshot, packed-evidence and identity-integrity regressions are available in the `scripts/verify-compact-*.mjs` scripts and use isolated fixtures where designed. Some performance/scale checks create large disposable databases; inspect each script before running it. Never substitute synthetic tests for mainnet evidence or direct any repair/collector command at production without separate authorization.

## Security, Disclaimer and Links

### Security

The application never requires wallet seed phrases or private keys.

Mainnet routes move real assets. Always verify:

- source and destination networks
- amount
- recipient wallet
- wallet transaction details
- protocol and network fees

The production deployment includes security headers and a public `security.txt` file:

https://www.machinabridge.xyz/.well-known/security.txt

### Disclaimer

Machina Bridge is an independent community-built project and is not an official Arc or Circle product.

Verified mainnet bridge routes transfer real USDC. Blockchain transactions are irreversible, and network or protocol fees may apply.

Machina currently charges no service commission.

### Links

- Live app: https://www.machinabridge.xyz/
- Repository: https://github.com/dharmanan/Machina-Bridge
- X: https://x.com/KohenEric
- Arc docs: https://docs.arc.network/
- Arc Explorer: https://explorer.arc.io
- Solscan: https://solscan.io

### License

MIT
