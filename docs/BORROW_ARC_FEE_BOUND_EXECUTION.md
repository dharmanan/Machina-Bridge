# Arc Borrow execution routing and fee-bound safety

Status: **blocked for wallets advertising native EIP-5792 atomic batching**, unless a separately attested, fee-bound transaction transport is available. **Do not turn off the guard, hide capability responses, or treat a simulation as fee enforcement.**

## Evidence reviewed (2026-10-26)

- The pinned `@circle-fin/borrow-kit@1.0.0` and `@circle-fin/adapter-viem-v2@1.19.0` integration supports an atomic EOA path on Arc through `Multicall3From`.
- In `src/lib/borrowSdkTransport.ts`, the EOA path separately verifies the exact SDK calls, Morpho market, allowance and authorization sequence, account type, signed payload, quote economics, chain, simulated state, gas estimate, nonce, block hash, and transaction fee ceiling **before** a single `eth_sendTransaction` request. Receipt and position proofs are checked afterward.
- The adapter also has an EIP-5792 / `wallet_sendCalls` path. Those call tuples **do not bind gas limit and maxFeePerGas**. `sendCalls()` in the guarded transport deliberately rejects them.
- `detectBorrowAtomicSupport()` in `src/lib/borrowProduction.ts` rejects native-atomic wallet responses even when the SDK can also identify an EOA route, because the SDK might select the unbound native path.
- `src/components/MainnetBorrow.tsx` must not show green execution readiness on the strength of `wallet_getCapabilities` alone. Preview calculations are not authorization to send funds.
- Current browser wallet's **on-chain EOA status has not been independently verified in this report**. Historical successful Swaps cannot prove which Borrow transport its provider selects.

## Tested behavior

`scripts/verify-borrow-sdk-integration.mjs` uses the real pinned Borrow Kit and /next adapter, with mocked Circle HTTP, Arc RPC and wallet methods; no live signing.

It verifies six EOA transaction paths and their fee/nonce/calldata bindings. Additional regressions confirm a simulated native-atomic wallet cannot send either `eth_sendTransaction` or `wallet_sendCalls` through the currently guarded transport.

**These are mocked transport tests, not live-mainnet execution proofs.** The existing canary and mainnet public write restrictions remain intact.

## Requirements before enabling native-capability wallets

1. Resolve the wallet's actual account type and route using *read-only* on-chain code and wallet capabilities; no private keys.
2. Identify an **explicit supported SDK/API execution selector** for fee-bound EOA single-transaction batching without altering the wallet's truthful capability response. If none exists, implement a separately reviewed adapter to the verified `Multicall3From` primitive; never fall back to multi-transaction approval/borrow/revoke sequences.
3. Prove for the selected route that the wallet signs one atomic call with fixed destination, canonical calldata, exact account, stable nonce, bounded gas and EIP-1559 fee fields. Verify full Morpho position and token transfer effects with deterministic positive/negative simulations.
4. Test rejection, timeout, wallet modification, fee overrun, reorg, partial failure, quote expiry, prior authorization, receipt mismatch, and recovery with **no automatic resubmission**.
5. Run independent review of the adapter and wallet-provider behavior before removing the controlled rollout gate. Maintain the known dependency security findings as separate open risks.

The supported route is **not** established simply because CI reports green. Any code that unblocks live Borrow without these proofs is a regression.
