# Machina Bridge

**Arc DeFi, cross-chain USDC transfers, supported swaps, and wallet activity.**

Machina Bridge is an independent, community-built interface for supported Arc blockchain and DeFi services. The application is available as a **Public Beta**.

**[Launch Machina Bridge](https://www.machinabridge.xyz/)** · [Arc documentation](https://docs.arc.network/)

## Features

| Feature | What it does | Availability |
| --- | --- | --- |
| **Wallet Activity** | View recent Arc wallet transactions and transfers reported by Blockscout. | Mainnet · Read-only |
| **Bridge** | Transfer USDC between Arc and supported Ethereum, Base, OP Mainnet, Arbitrum, and Solana routes. | Mainnet · Wallet-confirmed transactions |
| **Earn** | Explore selected Arc USDC vaults and request deposits or withdrawals through Circle Earn Kit. | Mainnet · Supported vaults |
| **Borrow** | Experimental borrowing implementation retained in the source; removed from the public navigation. | **Paused** |
| **Swap** | Swap supported Arc mainnet tokens through configured integrations; a separate testnet interface is available. | Mainnet · Supported routes; **Testnet only** for the separate testnet interface |

The app also includes a separate testnet experience for development and experimentation. **Mainnet Gateway forwarding is not enabled.** Availability, supported routes, market terms, and liquidity may change.

## Arc Intelligence

Arc Intelligence was an experimental Arc network, DEX, lending and cross-chain analytics service. It has been **retired from the public application**. Its historical source code and validation scripts remain in this repository for reference, but its endpoints and datasets are not part of the supported live Machina product. The service is scheduled to be shut down independently from Bridge, Swap, Earn and Wallet Activity.

Any archived data is informational and does not provide investment recommendations; a missing or incomplete value is not presented as a confirmed zero. This is not a live data product.

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

**Borrow is paused and is not available in the public navigation.** The archived Borrow component shows the **Morpho cirBTC / USDC** markets on Arc through Circle Borrow Kit. It is one screen with two depths: a short **standard view** for anyone, and **Advanced details**, a section that is closed until opened and holds every technical check and piece of evidence. Nothing technical was removed; it was moved. Each market is also checked against Morpho Blue on Arc: its ID must hash from the on-chain parameters, and the tokens and LLTV must match Circle's data. A market that cannot be checked is never shown as verified. A market card shows only the asset pair, the short market ID that tells the two markets apart, Borrow APY, available liquidity and one short status (for example **Available** or **Unavailable for borrowing**), as facts, not advice; markets are never ranked or recommended. The market ID, oracle and oracle price, rate model, on-chain verification, LLTV, utilization, total borrowed and data timestamp are under **Advanced details › Market details**.

The standard view answers a few questions in order. **Current loan** is the connected wallet's position from the Borrow Service: each loan shows its Current debt, Collateral, Current Health Factor and Liquidation Price, no wallet-wide Health Factor is ever computed, and **No active loan** is only said after a complete, successful read; a failed read says **Unavailable**. **New borrow estimate** has two inputs, the borrow amount and a Target Health Factor, and a real quote for your wallet: Borrow Amount, Collateral Required (with any collateral buffer stated as part of the collateral, not a separate fee), your wallet's real cirBTC balance (read on-chain), Borrow APY (variable), Estimated Gas / Fees, **Estimated Health Factor** with your target next to it (`Your target: 1.50 — Met`) and Liquidation Price. One **status** below the inputs says what matters most: the real blocker first (for example **Insufficient collateral**, **Wallet not supported**, **Target Health Factor not met**, **Market unavailable**) or **Transaction checks passed — Preview only**. The status only chooses which check to say first, from the same checks the write boundary runs ([`src/lib/borrowStatus.ts`](src/lib/borrowStatus.ts)); it never replaces, hides or overrides one. The optional collateral comparison and Circle's separate collateral sizing preview (reference only, not a quote a transaction could be prepared from) are inside Advanced details.

**Health Factor target.** Circle's Borrow Kit quote and borrow call take no collateral and no target Health Factor, and Circle sizes the collateral itself: at a base Health Factor of 1.20 plus the call's `slippageBps` as a collateral buffer (300 by default, so a default quote reads about 1.24). That buffer is the one supported lever: Machina asks Circle for the buffer that reaches your target, accepts it only when the quote Circle returns for it reaches the target on its raw Health Factor, and uses the same buffer as the slippage of the transaction it would prepare. If no allowed buffer reaches it, the borrow stays **Blocked**; your target is never lowered and no other borrowing method is prepared. `node scripts/verify-mainnet-borrow-target-live.mjs` re-checks this relation against the live service (read-only). That the signed borrow supplies exactly the quoted collateral is not visible to the SDK before signing; it is a check for the first real canary.

**Transaction checks** are the shared safety checks in [`src/lib/borrowWriteSafety.ts`](src/lib/borrowWriteSafety.ts), listed under **Advanced details › Wallet and transaction checks** grouped as Wallet and network, Market, Quote and limits, Balances, Loan and Transaction history, each as **Pass**, **Warning**, **Blocked** or **Unavailable**, with how old each piece of data is. They are the same checks the write boundary in [`src/lib/mainnetBorrow.ts`](src/lib/mainnetBorrow.ts) runs again, on fresh reads, before any future write: Arc mainnet (chain 5042), an EIP-5792 atomic-batch wallet (no separate-transaction fallback), a wallet session that is dropped when the wallet or network changes, a quote that is fresh (60 s), bound to its market or loan, wallet, amount and slippage, and unchanged since review, the market verified on-chain, a readable oracle, liquidity and balances compared exactly in token units, the pinned Circle Borrow Adapter address, and a 70% loan-to-value limit. A quote whose Health Factor is below your selected target (for example 1.24 against 1.50) blocks; Machina does not prepare a transaction with different collateral. Health Factor and LTV are compared as the raw numbers the service reports, never the rounded ones on screen. Repay and Add collateral are not held to the new-borrow limits; Withdraw collateral must still meet your Health Factor target, and Close loan must cover the whole debt with its interest. Missing, stale or unverifiable data is "Unavailable" and blocks. **Passing does not mean a transaction can be sent**: the write gate is a separate, closed switch.

**Quote expiry.** A quote, and the market, on-chain check, loans and balances it was read with, are used for 60 seconds. They are read together, so they expire together. When that passes, the standard view shows only **Quote expired. Refresh to get current terms.** and a **Refresh quote** button (the estimate figures are hidden, not shown stale); Advanced details itemises which data is stale. Refreshing only reads again, never sends anything, and keeps the amount and target you typed.

**Wallet compatibility** is what the connected wallet answered to one read-only question, `wallet_getCapabilities` for Arc: **Atomic transactions supported**, **Not supported** or **Could not verify** (an error, a rejected prompt, an empty answer or no answer within 8 s). Only the first is suitable for Borrow; the standard view says **Wallet not supported** or **Wallet not verified** otherwise, and shows **Wallet supports atomic transactions on Arc** when everything passes. A change of wallet or network drops the answer and asks again. To check a wallet on a Vercel Preview: connect it on Arc Mainnet, open Borrow, choose a market and type an amount; **Advanced details › Wallet and transaction checks** shows the wallet's own answer. Nothing else is asked of the wallet.

**Attempt history.** Writes that were started from this browser are recorded per wallet and network, before anything is sent, and survive a reload. A write that is running, was submitted, was cut off by a reload, failed or finished blocks every further write on that market or loan until the position has been read again and a person has confirmed it; nothing clears it on its own. If the history cannot be read, saved or is not available, nothing is prepared and the history is left as it is. This protects against double clicks and reloads. It does not follow you to another device or browser and it is lost if browser data is cleared, so it is not enough on its own for real funds. `node scripts/verify-mainnet-borrow-markets-onchain.mjs` repeats the on-chain market check from the command line.

Anything the Borrow Service does not report is shown as "Not reported" rather than estimated. The borrow rate is variable, and a position can be liquidated when its health factor falls below 1.0; the tab states both risks.

**Borrow transactions are not enabled.** The tab never asks a wallet to sign, approve a token, or send a transaction (its one wallet question is the read-only `wallet_getCapabilities`), and its action buttons are permanently disabled. Transaction functionality will require a separately reviewed release; read-only quotes do not imply that borrowing is live.

The current source-level control is defined in [`src/config/mainnetBorrow.ts`](src/config/mainnetBorrow.ts).

## Fees and data transparency

Machina currently displays no additional Machina service commission for its supported transaction flows. **That does not make transactions free:** blockchain gas, Circle or other protocol fees, and any applicable Solana account costs may still apply. Confirm current amounts in the interface before signing.

The retired Intelligence service is not required for Bridge, Swap, Earn, wallet activity or dashboard transaction tracking. These rely on their own chain, Circle and Blockscout integrations.

Transactions involving real assets are irreversible and carry financial risks. Use a wallet you control and never share a seed phrase or private key.

## Technology and architecture

- **Frontend:** React, TypeScript, Vite, Wagmi, RainbowKit, and Solana wallet integration.
- **Blockchain integrations:** Circle CCTP / Bridge Kit, Earn Kit, Borrow Kit market reads, and supported Arc DeFi protocols.
- **Hosting:** Vercel for the web application and same-origin API proxies.
- **Retired analytics source:** Experimental Node.js / SQLite code remains for reference only; Railway is not a dependency of supported mainnet user flows.

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

These commands are development checks, **not** proof of a successful mainnet transaction or a security audit. Supported user flows depend on their external chain, Circle and Blockscout services.

Environment variables vary by deployment. Browser variables prefixed with `VITE_` are exposed to the frontend: **never put API secrets, private keys, or wallet recovery phrases in them**. See [`src/config/`](src/config/) for network-related configuration.

## Independence, security, and license

Machina Bridge is an independent project, **not an official Arc, Circle, Uniswap, or Morpho product**. Protocol integrations do not constitute endorsements, investment advice, or guarantees of funds or returns.

- [Live application](https://www.machinabridge.xyz/)
- [Source code](https://github.com/dharmanan/Machina-Bridge)
- [Security contact](https://www.machinabridge.xyz/.well-known/security.txt)
- [Arc Explorer](https://explorer.arc.io)
- [X](https://x.com/KohenEric)

Licensed under the [MIT License](LICENSE).
