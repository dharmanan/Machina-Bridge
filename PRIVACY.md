# Privacy

Machina Bridge has no user accounts, no sign-up, and no analytics or tracking scripts. It does not run a database of its users or their transfers.

## What stays in your browser

Transfer records, recovery records, Solana deposit refunds and testnet history are saved only in your browser's local storage. They are not sent to a Machina server. They do not follow you to another device or browser, and they are deleted if you clear your browser data. Machina rebuilds what it can from the blockchain, for example open Solana deposits.

## What leaves your browser

To show balances and complete transactions, the app sends your **public wallet addresses** and **transaction hashes** to the services that hold that data. These services see the request and your IP address:

| Purpose | Service |
| --- | --- |
| Arc wallet activity | Blockscout, through Machina's own API proxy |
| Balances and transactions | Public blockchain RPC providers for Arc, Ethereum, Base, OP Mainnet, Arbitrum, Solana and Sui. Some Solana reads go through Machina's own API proxy. |
| Cross-chain transfers | Circle: the CCTP attestation service and Circle's kits |
| Swap quotes | Uniswap and Circle |
| Wallet connection | Your wallet. If you connect through WalletConnect, its relay also sees the connection. |

Public wallet addresses and transactions are already visible to anyone on the blockchain. Machina never asks for, receives or stores a seed phrase, a private key or a password.

## Hosting

The app and its API proxies run on Vercel. As the hosting provider, Vercel processes requests, including IP addresses, under its own privacy policy. The API proxies keep a short-lived, in-memory request counter per IP address to limit abuse. It is not stored or logged by Machina.

## SDK telemetry

Telemetry in the Circle SDKs is turned off where the SDK supports it.

## Contact

For privacy questions, open an issue in the [repository](https://github.com/dharmanan/Machina-Bridge). For anything security-related, follow [SECURITY.md](SECURITY.md).
