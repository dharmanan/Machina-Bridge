# Machina Bridge

**Testnet swaps, cross-chain USDC bridging, persistent transfer tracking, and guarded Arc mainnet readiness work.**

[Live App](https://machinabridge.vercel.app) · [Repository](https://github.com/dharmanan/Machina-Bridge)

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

Machina Bridge's public transaction flows currently remain testnet-only. Test assets have no real monetary value. Mainnet support is being prepared behind explicit runtime locks.


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


---

## Security

Machina Bridge is intended for testnet experimentation.

The production deployment includes security headers and a public `security.txt` file. The application never requires wallet seed phrases or private keys.

Security information:

https://machinabridge.vercel.app/.well-known/security.txt

---

## Disclaimer

Machina Bridge is an independent community-built project and is not an official Arc product.

All currently enabled swap and bridge transaction flows are testnet-only. Mainnet support remains locked until the guarded production flow is fully verified and deliberately enabled.

---

## Links

- Live app: https://machinabridge.vercel.app
- Repository: https://github.com/dharmanan/Machina-Bridge
- X: https://x.com/KohenEric
- Arc docs: https://docs.arc.network/
- ArcScan: https://testnet.arcscan.app

## License

MIT
