# Security Policy

Machina Bridge moves real funds on mainnet. Security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

1. Use GitHub's private reporting: **Security → Report a vulnerability** in this repository.
2. If that form is not available to you, open a public issue that says only that you have a security report and asks for a private channel. Do not include any details in it.

Please include:

- the affected flow (Bridge, Swap, Earn, Dashboard, Solana deposit reclaim, Sui, API proxy, build/CI) and the network;
- steps to reproduce, or a proof of concept that **does not move other people's funds**;
- the impact you expect and any transaction hashes involved.

## What to expect

Machina Bridge is maintained by an independent developer, so responses are best effort:

- an acknowledgement, normally within a few days;
- an assessment, and a fix or mitigation, prioritised by the impact on funds;
- credit in the fix, if you want it, once the issue is resolved.

A report is disclosed publicly only after a fix is released, or after both sides agree.

## Scope

In scope:

- the live application at <https://www.machinabridge.xyz> and the `main` branch of this repository;
- the transaction checks that run before a wallet is asked to sign (EVM and Solana), and the recovery and refund flows;
- the same-origin API proxies in [`api/`](api/), the build, and the dependency setup.

Out of scope:

- vulnerabilities in third-party contracts, protocols, wallets or SDKs, such as Circle CCTP, Arc, Uniswap, vault operators, Phantom or MetaMask. Report those to their owners. A report showing that Machina's own checks fail to catch a dangerous transaction they produce **is** in scope;
- the retired Arc Intelligence source and the paused Borrow preview, unless the issue reaches the live application;
- denial of service by volume, social engineering, and findings that need a compromised device or wallet.

## Safe harbour

Good-faith research that follows this policy, avoids privacy violations, does not touch other users' funds and does not degrade the service for others will not be pursued.

## Current security status

What is verified, what is trusted and which limitations are known is documented in [docs/SECURITY_STATUS.md](docs/SECURITY_STATUS.md).
