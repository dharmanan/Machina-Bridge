# Machina Bridge

**USDC bridging between Arc, major EVM networks, and Solana, plus Arc Mainnet USDC Earn.**

[Live App](https://machinabridge.vercel.app) · [Repository](https://github.com/dharmanan/Machina-Bridge)

---

## Overview

Machina Bridge is an independent community-built application centered on Arc.

The app now opens on **Mainnet by default** for users without a saved network preference. Testnet remains available from the network selector.

Current product surfaces include:

- Arc ↔ Base USDC bridging
- Arc ↔ Ethereum USDC bridging
- Arc ↔ Optimism USDC bridging
- Arc ↔ Arbitrum USDC bridging
- Arc ↔ Solana USDC bridging
- Arc Mainnet USDC Earn with Galaxy USDC and Gauntlet USDC Prime
- Separate EVM Bridge and Solana Bridge views
- Persistent transfer activity and recovery handling
- Wallet-assisted EVM network switching
- Solana refundable deposit tracking
- A separate testnet environment for swap, bridge, Gateway, Solana, and development flows

Mainnet Gateway forwarding remains disabled.

---

## Mainnet Routes

The following routes are enabled and marked verified in the application:

| Feature | Route | Asset | Status |
| --- | --- | --- | --- |
| EVM Bridge | Arc ↔ Base | USDC | Verified |
| EVM Bridge | Arc ↔ Ethereum | USDC | Verified |
| EVM Bridge | Arc ↔ Optimism | USDC | Verified |
| EVM Bridge | Arc ↔ Arbitrum | USDC | Verified |
| Solana Bridge | Arc ↔ Solana | USDC | Verified |

Mainnet routes use Circle CCTP and have been validated with small real-value transfers in both directions.

---

## Testnet Routes

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

---

## Bridge Experience

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

---

## Arc Mainnet Earn

Earn offers Arc Mainnet USDC deposits and withdrawals through Circle Earn Kit. The current launch vaults are **Galaxy USDC** and **Gauntlet USDC Prime**, with Morpho-backed vault exposure where applicable.

Users review a quote before confirming each deposit or withdrawal in their own wallet. **Machina fee: 0 USDC.** Network and protocol costs may still apply.

Vaults are operated by third parties. Yields vary, and DeFi, smart contract, protocol, and market risks remain. Circle Guarded does not guarantee returns or protect principal.

---

## Fees

Machina currently charges **no service commission**.

The interface shows:

- **Machina fee: 0 USDC**
- Circle or protocol fees where applicable
- Network fees paid to the source or destination blockchain
- Solana refundable deposits where applicable

A Machina fee of 0 USDC does **not** mean a transfer is free. Network and protocol costs may still apply.

---

## Solana Refundable Deposits

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

The refundable deposit panel is collapsed by default. The return flow is implemented; final post-window mainnet validation for the first launch deposits is still pending as of 2026-09-28.

---

## Wallet Integrations

### EVM

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

### Solana

Phantom is used for Solana connection and signing.

Supported Solana environments:

- Solana Mainnet
- Solana Devnet

### Sui

A Sui wallet connector is present in the testnet interface. There is currently no Sui bridge route exposed in the production mainnet bridge flow.

---

## Arc Mainnet

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

---

## Solana Mainnet

| Parameter | Value |
| --- | --- |
| CCTP Domain | `5` |
| USDC Mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| MessageTransmitterV2 | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| TokenMessengerMinterV2 | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| Explorer | `https://solscan.io` |

---

## Mainnet USDC Addresses

| Network | USDC |
| --- | --- |
| Arc | `0x3600000000000000000000000000000000000000` |
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| OP Mainnet | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

---

## Arc Testnet

| Parameter | Value |
| --- | --- |
| Chain ID | `5042002` |
| Default RPC | `https://rpc.testnet.arc.io` |
| Gas asset | USDC |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |

---

## Technology

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
- Morpho vault data
- Circle Solana adapter
- Solana Web3.js
- Mysten dApp Kit
- Vercel serverless APIs

---

## Project Structure

```text
Machina-Bridge/
├── api/
├── public/
│   ├── .well-known/
│   │   └── security.txt
│   ├── robots.txt
│   └── sitemap.xml
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

---

## Quick Start

### Requirements

- Node.js 18+
- npm
- An EVM wallet such as MetaMask or Rabby
- Phantom for Solana flows
- Native gas assets and USDC for the networks being used

### Clone and install

```bash
git clone https://github.com/dharmanan/Machina-Bridge.git
cd Machina-Bridge
npm install
```

### Run locally

```bash
npm run dev
```

The Vite development server runs on `http://localhost:3000`.

### Production build

```bash
npm run build
```

---

## Environment

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

---

## Validation

Useful checks:

```bash
npm audit
npm audit --omit=dev
npm run build
npm run verify:mainnet-cctp
npm run verify:mainnet-solana-cctp
npm run verify:mainnet-solana-bridgekit
```

---

## Security

The application never requires wallet seed phrases or private keys.

Mainnet routes move real assets. Always verify:

- source and destination networks
- amount
- recipient wallet
- wallet transaction details
- protocol and network fees

The production deployment includes security headers and a public `security.txt` file:

https://machinabridge.vercel.app/.well-known/security.txt

---

## Disclaimer

Machina Bridge is an independent community-built project and is not an official Arc or Circle product.

Verified mainnet bridge routes transfer real USDC. Blockchain transactions are irreversible, and network or protocol fees may apply.

Machina currently charges no service commission.

---

## Links

- Live app: https://machinabridge.vercel.app
- Repository: https://github.com/dharmanan/Machina-Bridge
- X: https://x.com/KohenEric
- Arc docs: https://docs.arc.network/
- Arc Explorer: https://explorer.arc.io
- Solscan: https://solscan.io

## License

MIT
