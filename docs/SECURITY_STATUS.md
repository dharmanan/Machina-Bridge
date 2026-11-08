# Security status

Last reviewed: 8 November 2026.

Machina Bridge is a **Public Beta**. It has not had an independent security audit. This page says what Machina checks before your wallet is asked to sign, what it trusts without verifying, and which limitations are known. It does not claim the application is free of vulnerabilities.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Principle: verify what the SDK produces before the wallet signs

Machina relies on third-party SDKs, mainly Circle Bridge Kit, Earn Kit and Swap Kit, which it has not audited line by line. It does not pass the transactions those SDKs build straight to your wallet: each one is checked independently first, and a transaction that fails a check never reaches the wallet.

| Flow | What is checked before signing | Source |
| --- | --- | --- |
| Arc ↔ Ethereum, Base, OP Mainnet, Arbitrum (CCTP) | Machina builds the approve, burn and mint calls itself against the pinned CCTP contracts and the route policy: network, amount, recipient and fee bound. A send whose result is unknown blocks any second burn until the chain shows what happened. | [`src/hooks/useMainnetCctp.ts`](../src/hooks/useMainnetCctp.ts), [`src/lib/mainnetCctpSendRecovery.ts`](../src/lib/mainnetCctpSendRecovery.ts) |
| Arc → Solana, EVM side | Each wallet request from Bridge Kit is decoded and allowed only for the expected contract, function, amount, recipient and fee bound. | [`src/lib/solanaBridgeEvmPolicy.ts`](../src/lib/solanaBridgeEvmPolicy.ts) |
| Solana → Arc, Solana side | Programs, instructions, accounts, amount, recipient and signers of the burn are checked. The validated burn is then compressed with Circle's frozen CCTP address lookup table, whose addresses are pinned in the code. The compressed burn must decompile to exactly the same instructions, or the original is used. | [`src/lib/solanaBridgeTxPolicy.ts`](../src/lib/solanaBridgeTxPolicy.ts) |
| One burn per transfer | Wallet locks and a saved attempt journal stop a second burn signature. A signed burn is settled only from chain evidence: landed, failed on chain, or expired. | [`src/lib/solanaSendGuard.ts`](../src/lib/solanaSendGuard.ts), [`src/lib/solanaSendRuntime.ts`](../src/lib/solanaSendRuntime.ts) |
| Solana refundable deposits (reclaim) | Only the original rent payer can reclaim, and only after the on-chain window. The signed reclaim is simulated, and the Lighthouse assertions Phantom adds are decoded and allowed only as read-only checks. | [`src/lib/mainnetSolanaReclaim.ts`](../src/lib/mainnetSolanaReclaim.ts), [`src/lib/solanaLighthousePolicy.ts`](../src/lib/solanaLighthousePolicy.ts) |
| Arc ↔ Sui (CCTP) | Pinned Circle Sui packages; source burns are identified from chain data before any recovery or mint. | [`src/config/mainnetSui.ts`](../src/config/mainnetSui.ts), [`src/lib/mainnetSuiRecovery.ts`](../src/lib/mainnetSuiRecovery.ts) |
| Earn (Circle Earn Kit) | The operation is saved before the wallet is asked. Each wallet request from Earn Kit is decoded and must match it: at most one approval to the pinned Earn adapter, then one `execute` for the reviewed vault and amount. The outcome is settled only from the chain. | [`src/lib/earnJournal.ts`](../src/lib/earnJournal.ts) |
| Swap on Arc (Uniswap, Circle Swap Kit) | Pinned tokens, routers and spenders, quote freshness, slippage options and per-swap ceilings of about 10 USD. Circle Swap Kit only sees a guarded wallet: each request is journaled and checked against the review, and the minimum output is compared with an independent price. | [`src/lib/uniswapArcPolicy.ts`](../src/lib/uniswapArcPolicy.ts), [`src/lib/swap/circleSwap.ts`](../src/lib/swap/circleSwap.ts), [`docs/swap-unified.md`](swap-unified.md) |

These paths are covered by negative tests: a refused transaction must never reach the wallet; second burns are blocked; signed, expired and tampered inputs are rejected. They also had real mainnet transfers, including a Solana → Arc transfer and six deposit reclaims on 7 November 2026.

## Infrastructure and supply chain

- **Installs:** Vercel installs with `npm ci --ignore-scripts` from the lockfile, so dependency install scripts do not run.
- **Third-party responses:** responses from Circle Iris, Earn Kit and other APIs are size-limited, and a Zod collection backport limits validation cost. See [`docs/dependency-security/REVIEW.md`](dependency-security/REVIEW.md).
- **Telemetry:** SDK telemetry is turned off where the SDK supports it.
- **Server-side state:** there is no server-side database for user transfers. The former Redis/Upstash records were removed, and transfer and recovery records stay in the user's browser.
- **Solana RPC proxies:** limit methods, parameters, request and response size, and time per call, plus 600 requests per minute per client.
- **Browser hardening:** CSP with `frame-ancestors 'none'` and a hashed inline script; HSTS.
- **CI:** GitHub Actions are pinned to full commit SHAs, and a test fails if one is not.
- **SBOM:** a software bill of materials (SPDX) of every dependency can be exported from GitHub at any time: Insights → Dependency graph → Export SBOM.

## What Machina trusts without verifying

- The Circle CCTP contracts and programs, and Circle's attestation service (Iris).
- Your wallet (MetaMask, Phantom, Slush, and others) showing and signing what it is given.
- Public RPC providers for reads. Answers that decide a refund or a recovery are cross-checked against chain data, but a provider can still be unavailable or out of date.
- Vercel hosting and the npm packages pinned in `package-lock.json`.
- Third-party vaults (Earn) and DEX liquidity (Swap). Their contract and market risk stays with the user.

## Known limitations

These are known, tracked and of low or medium impact. None of them lets a third party move a user's funds. A vulnerability that could is reported privately and fixed before it is described here.

| Area | Limitation | What is in place |
| --- | --- | --- |
| Release process | A change merged to `main` is deployed by Vercel without waiting for the GitHub CI run. | Every change is tested locally before it is pushed. On `main`, CI runs the fast safety suites and the dependency audit unless a commit opts out with `[skip ci]`; the browser and source suites run on pull requests and release checks. |
| Solana RPC proxies | The per-client limit (600 requests per minute) is counted in the memory of each serverless instance, so it is best effort rather than a global limit. | Allowed methods, parameters, request and response sizes, and time per call are also limited. A limited request never reaches a provider. |
| Dependencies | `npm audit` reports two upstream advisories: Zod (memory use on oversized collections) and elliptic (a risky cryptographic primitive). | Zod is guarded by a backport and response size limits. elliptic was not found reachable in the production bundle. Both wait for upstream fixes. |
| CI and browser hardening | The CSP allows HTTPS and WSS connections broadly, because wallets and RPC providers vary; there is no CodeQL scan yet. | CI runs `npm audit` and the security regression suites. Narrowing the CSP needs testing with real wallets and is planned. |
| Phantom, Solana → Arc | Phantom adds a check that pins the USDC mint account, which changes often. A burn confirmed slowly can therefore fail on chain. | No USDC moves; only the network fee (~0.00009 SOL) is lost, and the app says the transfer can be retried. Confirm promptly when Phantom opens. A fix depends on Phantom. |

## Not in the live product

- **Borrow** is paused. The preview cannot request signatures.
- **Arc Intelligence** is retired. Its source is kept for reference only.
