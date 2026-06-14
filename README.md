# Machina Bridge v2.3

Machina Bridge is a testnet swap and bridge app for Sepolia, Arc Testnet, Base Sepolia, Optimism Sepolia, Arbitrum Sepolia, and Solana Devnet. It keeps the Sepolia ETH <-> USDC swap flow intact, adds multi-route USDC bridge paths, and includes the latest tracker, persistence, and reliability improvements in v2.3.

[![Watch the demo on YouTube](https://img.youtube.com/vi/pdldO1BlC-k/maxresdefault.jpg)](https://www.youtube.com/watch?v=pdldO1BlC-k)

> ▶ Click the image above to watch the demo on YouTube.

## v2.3 Update

This v2.3 release focuses on practical bridge usability, activity persistence across devices, and safer long running flow handling.

1. Improved one click UX for Solana forwarding by making deposit and send run in one continuous flow.
2. Improved bridge success summary with cleaner Sent / Fee / Arrived values and clearer transaction links.
3. Added server side bridge activity persistence using Redis so history survives browser and device changes.
4. Added local plus server activity merge with deduplication to keep the bell panel consistent.
5. Replaced fixed history size behavior with 30 day retention for both local and server activity records.
6. Added API hardening layers: rate limiting, idempotency keys, strict CORS allowlist, and optional request signing.
7. Added production ready Vercel serverless activity endpoints and environment setup for Preview and Production.
8. Improved bridge tracker behavior for already completed mint attempts by handling nonce already used as completed.
9. Improved activity dismissal behavior so stale items can be dismissed reliably across transfer and activity sources.
10. Removed long ETA warning for Arc origin routes where that delay guidance does not apply.

### User visible changes in v2.3

1. Activity bell now reflects real status buckets more reliably: In Progress, Ready to Mint, Completed.
2. Minted transfers are moved to Completed with better edge case handling.
3. Dismiss and Clear actions now behave consistently for older and mixed source records.
4. Bridge history no longer disappears when you switch browser, profile, or device with the same wallet.
5. App now works on mobile via the in-app browsers of MetaMask, Rabby, and Phantom — swap, bridge, and activity tracking all function without issues on mobile.

## v2.2 Update

This `v2.2` release bundles the latest bridge tracker, route reliability, and RPC fallback work for the current multi-chain bridge surface.

- Added new EVM bridge chain support for `Base Sepolia`, `Optimism Sepolia`, and `Arbitrum Sepolia`.
- Added route-aware CCTP tracker coverage for `Optimism -> Arc` and `Base -> Arc` flows.
- Added clearer tracker completion UX (`Funds received on Arc` + completion time).
- Fixed stale/waiting tracker states after destination mint confirmation.
- Fixed Base Sepolia USDC address and balance-read reliability issues.
- Added RPC fallback transports to reduce single-provider CORS/502 failures.
- Added attestation delay guidance for Circle IRIS `404` indexing windows.
- Added Arbitrum fee-overestimation warning copy for MetaMask testnet UX.

## Recent Delivery Notes

- Expanded Arc-centric EVM bridge routing across `Sepolia`, `Base Sepolia`, `Optimism Sepolia`, and `Arbitrum Sepolia`.
- Refined source/destination selectors and auto chain switching behavior.
- Added pending bridge persistence and resume flow for long-running CCTP operations.
- Added dynamic ETA messaging for CCTP routes (`Base 15-20`, `Optimism 20-30`).
- Fixed tracker modal lifecycle bugs (freeze, dismiss behavior, stale completion state).

## Roadmap

- Planned: wallet-connected `Ready to mint` discovery for pending CCTP messages.
- Status: intentionally deferred for now; tracked for a later release.

## v2.1 Update

This `v2.1` release bundled the previous UI, bridge, Solana, and security baseline updates.

- Rebuilt the app UI into a cleaner light theme with English-only copy across the product.
- Refined navigation and branding, including updated docs links, footer versioning, and a direct faucet shortcut.
- Kept swap behavior intentionally narrow: Sepolia `ETH <-> USDC` remains the only swap route.
- Expanded bridge coverage with three modes: EVM `Sepolia <-> Arc`, EVM to Solana forwarding, and Solana Devnet to Arc bridging.
- Added dedicated Phantom Solana connection handling and stronger EVM chain switching/add-chain support.
- Improved bridge reliability with clearer status states, gateway deposit polling, recipient validation, and retry handling for `replacement transaction underpriced` wallet errors.
- Refreshed the dependency tree, added targeted npm overrides, cleared the previous audit warnings, and revalidated the app with a production build.

## Supported Flows

| Flow | Route | Token | Status |
| --- | --- | --- | --- |
| Swap | Sepolia `ETH <-> USDC` | ETH / USDC | Active |
| EVM Bridge | Sepolia / Base / Optimism / Arbitrum `USDC <-> Arc Testnet USDC` | USDC | Active |
| Gateway Forwarding | Sepolia or Arc `USDC -> Solana Devnet` | USDC | Active |
| Solana Bridge | Solana Devnet `USDC -> Arc Testnet` | USDC | Active |

## What Changed

### Product and UI

- Reworked the application shell around a calmer `v2.x` visual system.
- Standardized user-facing content in English.
- Updated the header, footer, docs link, faucet entry point, and wallet status display.
- Improved contrast, balance visibility, and tab readability across Swap, Bridge, and Dashboard.

### Bridge and Wallet Work

- Added a shared Wagmi + RainbowKit provider setup for Sepolia, Arc, Base, Optimism, and Arbitrum.
- Added wallet-assisted EVM chain switching and wallet chain registration.
- Added Phantom Solana support for Solana-side connection and signing.
- Added Circle CCTP route support for Base, Optimism, and Arbitrum into Arc.
- Added Circle Gateway forwarding support for EVM to Solana delivery.
- Added Solana Devnet to Arc bridging support through Bridge Kit + Phantom.
- Added Gateway deposit tracking, fee estimation, recipient ATA derivation, and forwarding status polling.
- Added retry handling around nonce replacement issues seen during bridge submissions.

### Security and Maintenance

- Updated the dependency set to the current app baseline used by `v2.x`.
- Added npm `overrides` for known vulnerable transitive packages.
- Regenerated the lockfile after remediation.
- Cleaned the npm audit findings and rechecked the production build.

## Screenshots

### Swap
![Swap Interface](./src/assets/swapv2.png)

### Bridge
![Bridge Interface](./src/assets/bridgev2.png)

### Dashboard
![Dashboard](./src/assets/dashv2.png)

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- An EVM wallet such as MetaMask
- Optional: Phantom for Solana Devnet flows
- Sepolia testnet ETH
- Sepolia testnet USDC from Circle faucet

### Environment

Copy `.env.example` into your local env file and set the values you need.

| Variable | Purpose |
| --- | --- |
| `VITE_SEPOLIA_RPC` | Sepolia RPC used by the app |
| `VITE_ARC_TESTNET_RPC` | Arc Testnet RPC |
| `VITE_SOLANA_DEVNET_RPC` | Solana Devnet RPC |
| `VITE_WALLETCONNECT_PROJECT_ID` | Optional WalletConnect support |
| `VITE_CIRCLE_APP_ID` | Optional Circle client identifier |

### Install and Run

```bash
git clone https://github.com/dharmanan/Arc-Testnet-Bridge-Swap.git
cd Arc-Testnet-Bridge-Swap
npm install
npm run dev
```

Open `http://localhost:3000`.

### Production Build

```bash
npm run build
```

## Supported Networks

| Network | Chain / Domain | RPC | Explorer |
| --- | --- | --- | --- |
| Ethereum Sepolia | `11155111` | `https://ethereum-sepolia-rpc.publicnode.com` | `https://sepolia.etherscan.io` |
| Base Sepolia | `84532` | `https://base-sepolia-rpc.publicnode.com` | `https://sepolia.basescan.org` |
| Optimism Sepolia | `11155420` | `https://sepolia.optimism.io` | `https://sepolia-optimism.etherscan.io` |
| Arbitrum Sepolia | `421614` | `https://sepolia-rollup.arbitrum.io/rpc` | `https://sepolia.arbiscan.io` |
| Arc Testnet | `5042002` | `https://rpc.testnet.arc.network` | `https://testnet.arcscan.app` |
| Solana Devnet | Domain `5` | `https://api.devnet.solana.com` | `https://explorer.solana.com/?cluster=devnet` |

## Addresses and Endpoints

| Item | Address / Value | Network |
| --- | --- | --- |
| Uniswap V2 Router | `0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008` | Sepolia |
| Sepolia USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | Sepolia |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia |
| Optimism Sepolia USDC | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | Optimism Sepolia |
| Arbitrum Sepolia USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Arbitrum Sepolia |
| Arc Native USDC | `0x3600000000000000000000000000000000000000` | Arc Testnet |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | EVM forwarding |
| Solana Devnet USDC Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Solana Devnet |
| Solana Gateway Minter | `GATEmKK2ECL1brEngQZWCgMWPbvrEYqsV6u29dAaHavr` | Solana Devnet |

## Project Structure

```text
src/
  App.tsx
  components/
    BridgeTab.tsx
    DashboardTab.tsx
    SwapTab.tsx
    ui/
  hooks/
    useBridgeKit.ts
    useGatewayForwarding.ts
    usePhantomSolana.ts
    useSolanaBridge.ts
    useSwap.ts
  lib/
    chains.ts
    solana.ts
    wagmi.config.ts
    web3.tsx
```

## Development Notes

- Swap is intentionally limited to Sepolia `ETH <-> USDC`.
- Arc docs links now point to `https://docs.arc.network/`.
- Local markdown notes other than `README.md` are ignored from this workspace state.
- `postinstall` writes a minimal `tsconfig.base.json` shim needed by the current dependency stack.

## Validation

The current `v2.3` workspace was validated with:

```bash
npm run build
npm audit
```

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
```

## License

MIT
