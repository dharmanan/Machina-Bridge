# Machina Bridge

**Testnet swaps, cross-chain USDC bridging, persistent transfer tracking, and Machina's 40-day Arc Mainnet Countdown campaign.**

[Live App](https://machinabridge.vercel.app) · [Arc Mainnet Countdown](https://machinabridge.vercel.app/countdown) · [Launch Post](https://x.com/KohenEric/status/2085693568929137095?s=20)

---

## Overview

Machina Bridge is an independent community-built testnet application centered on Arc.

Current product surfaces include:

- Sepolia ETH ↔ USDC swapping
- USDC bridging between Arc Testnet and supported EVM testnets
- Arc Testnet → Solana Devnet forwarding
- Solana Devnet → Arc Testnet bridging
- Persistent bridge activity and transfer tracking
- Wallet-assisted EVM network switching
- A 40-day daily NFT countdown campaign on Arc Testnet

Machina Bridge currently operates on testnets. Test assets have no real monetary value.

---

## Arc Mainnet Countdown

Machina Bridge includes a 40-day onchain participation campaign tied to a project-defined Arc Mainnet target date.

Each wallet can claim one ERC-1155 NFT per campaign day on Arc Testnet. Claims are tied to the current campaign day, so missed days are not retroactively claimable.

### App progress tiers

| Claims | Tier |
| ---: | --- |
| 20 | Initiate |
| 30 | Pioneer |
| 35 | Degen |
| 40 | Genesis 40 |

The Degen tier is an app-level milestone derived from `claimedCount >= 35`.

The planned Degen benefit is **0% Machina service fee for the first 7 days after Arc Mainnet launch**. Network and protocol fees remain user-paid. The current testnet app does not add a separate Machina service fee.

Genesis 40 represents completion of all 40 daily claims.

### Countdown contract

| Item | Value |
| --- | --- |
| Network | Arc Testnet |
| Contract | `0xe2AF77Ea3Af88dB62CbF3eb0509b91751437892A` |
| Standard | ERC-1155 |
| Collection | Arc Mainnet Countdown |
| Symbol | `ARC40` |
| Total campaign days | 40 |
| Metadata | Fully onchain |
| Artwork | Fully onchain SVG |

[View the contract on ArcScan](https://testnet.arcscan.app/address/0xe2AF77Ea3Af88dB62CbF3eb0509b91751437892A)

The production contract address is pinned in the frontend source. Token IDs run from `1` through `40`, and each token's metadata and SVG artwork are returned directly from the contract as data URIs.

---

## Supported Flows

| Feature | Route | Asset | Status |
| --- | --- | --- | --- |
| Swap | Ethereum Sepolia ETH ↔ USDC | ETH / USDC | Active |
| EVM Bridge | Ethereum Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Base Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Optimism Sepolia ↔ Arc Testnet | USDC | Active |
| EVM Bridge | Arbitrum Sepolia ↔ Arc Testnet | USDC | Active |
| Gateway Forwarding | Arc Testnet → Solana Devnet | USDC | Active |
| Solana Bridge | Solana Devnet → Arc Testnet | USDC | Active |
| Countdown | Daily Arc Testnet NFT claim | ARC40 | Active |

---

## Bridge Experience

Current bridge functionality includes:

- Route-aware USDC bridging across supported EVM testnets and Arc Testnet
- Wallet-assisted chain switching and Arc Testnet registration
- Circle attestation tracking
- Pending-transfer recovery
- Ready-to-mint detection
- Source and destination transaction links
- Local and server-side activity persistence
- 30-day activity retention
- Deduplication between local and server records
- In Progress, Ready to Mint, and Completed activity states
- Retry and recovery handling for common wallet and transaction edge cases

---

## Wallet Integrations

### EVM

EVM wallet connections use Wagmi and RainbowKit.

Supported EVM networks:

- Ethereum Sepolia
- Arc Testnet
- Base Sepolia
- Optimism Sepolia
- Arbitrum Sepolia

### Solana

Phantom is used for Solana Devnet connection and signing.

### Sui

A Sui wallet connector is present in the current interface. There is currently no Sui bridge route exposed in the production bridge flow.

---

## Arc Testnet

| Parameter | Value |
| --- | --- |
| Chain ID | `5042002` |
| Default RPC in the app | `https://rpc.testnet.arc.io` |
| Gas asset | USDC |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Official docs | `https://docs.arc.network/` |

---

## Main Addresses

| Item | Address / Value | Network |
| --- | --- | --- |
| Arc Mainnet Countdown | `0xe2AF77Ea3Af88dB62CbF3eb0509b91751437892A` | Arc Testnet |
| Uniswap V2 Router | `0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008` | Ethereum Sepolia |
| Sepolia USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | Ethereum Sepolia |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia |
| Optimism Sepolia USDC | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | Optimism Sepolia |
| Arbitrum Sepolia USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Arbitrum Sepolia |
| Arc Native USDC | `0x3600000000000000000000000000000000000000` | Arc Testnet |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | EVM |
| Solana Devnet USDC Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Solana Devnet |
| Solana Gateway Minter | `GATEmKK2ECL1brEngQZWCgMWPbvrEYqsV6u29dAaHavr` | Solana Devnet |

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
- Solana Web3.js
- Mysten dApp Kit
- Solidity
- Vercel serverless APIs

The countdown Solidity source is compiled as part of `npm run build`.

---

## Project Structure

```text
Machina-Bridge/
├── api/
├── contracts/
│   └── MachinaCountdown1155.sol
├── public/
│   ├── .well-known/
│   │   └── security.txt
│   ├── robots.txt
│   └── sitemap.xml
├── scripts/
├── src/
│   ├── components/
│   ├── countdown/
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
- Phantom for Solana Devnet flows
- Testnet assets for the networks being used

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

The application has public RPC fallbacks for supported test networks and accepts environment overrides where configured.

Relevant browser-side variables include:

```text
VITE_SEPOLIA_RPC
VITE_ARC_TESTNET_RPC
VITE_BASE_SEPOLIA_RPC
VITE_OPTIMISM_SEPOLIA_RPC
VITE_ARBITRUM_SEPOLIA_RPC
VITE_SOLANA_DEVNET_RPC
VITE_WALLETCONNECT_PROJECT_ID
VITE_CIRCLE_APP_ID
```

Do not place private keys, wallet seed phrases, or backend secrets in `VITE_*` variables. Vite environment variables are exposed to the browser bundle.

---

## Validation

Useful local checks:

```bash
npm audit
npm audit --omit=dev
npm run build
```

A successful build also compiles the countdown contract artifact used by the project.

---

## Security

Machina Bridge is intended for testnet experimentation.

The production deployment includes security headers and a public `security.txt` file. The application never requires wallet seed phrases or private keys.

Security information:

https://machinabridge.vercel.app/.well-known/security.txt

---

## Disclaimer

Machina Bridge is an independent community-built project and is not an official Arc product.

Arc is currently on public testnet. The Machina countdown uses a project-defined campaign target and should not be interpreted as an official Arc mainnet launch-date announcement.

All current swap and bridge functionality is for testnet use.

---

## Links

- Live app: https://machinabridge.vercel.app
- Countdown: https://machinabridge.vercel.app/countdown
- Repository: https://github.com/dharmanan/Machina-Bridge
- X: https://x.com/KohenEric
- Countdown launch post: https://x.com/KohenEric/status/2085693568929137095?s=20
- Arc docs: https://docs.arc.network/
- ArcScan: https://testnet.arcscan.app

## License

MIT
