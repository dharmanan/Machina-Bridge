# Arc Uniswap pilot: closed until separately approved

Only native USDC → EURC on Arc Mainnet 5042, input **at most 0.1 USDC**,
with the configured wallet as both sender and recipient. cirBTC remains preview
only; Circle execution is unchanged and disabled. Existing router/runtime,
economic minimum/slippage, balance, gas, nonce, simulation, deadline, persistence
and duplicate-send checks remain mandatory. Each attempt uses Review Swap →
Confirm Swap → the wallet's explicit transaction confirmation → tracked status.

## Opening procedure — owner action after independent review

1. Obtain the owner's **public Arc EVM EOA address** (`0x` plus 40 hex digits),
   controlled by the existing connected wallet. Never request a key, seed phrase
   or signature for configuration. No test wallet is a production default.
2. Following independent review and explicit owner approval, make a separately
   reviewed release change setting `UNISWAP_ARC_WRITES_ENABLED` to `true`.
   **This commit leaves it false.** Configure the intended production build with
   `VITE_UNISWAP_ARC_PILOT_ENABLED=true` and
   `VITE_UNISWAP_ARC_PILOT_WALLET=<approved public address>`. These public Vite
   values are embedded at build time. Missing/invalid address, non-exact `true`,
   wrong wallet/network/direction or input above 0.1 fails closed. These settings
   do not change the separate live quote API gate or its server-only API key.
3. The owner separately authorizes a build/deployment. No deployment, gate
   activation, real signature or transaction is performed by this change.
   Using the approved wallet on Arc, enter **0.1 USDC → EURC**. Check the fresh
   minimum output, slippage, fees, recipient, router and deadline in Review Swap.
   Confirm Swap opens exactly one wallet request. Independently inspect the
   wallet transaction; only the owner approves it. Do not edit fees or calldata.
4. Observe and retain the hash, explorer result, actual received EURC and fee.
   Pending/Unknown is not success or permission to retry. At approval-window
   expiry cancel the open wallet request; the application cannot cancel it.
   Complete this one pilot and follow the closing procedure before further use.

## Maximum exposure per transaction

- Input: **0.1 USDC** (100000000000000000 native base units; 100000 ERC-20 units).
- Existing network fee ceiling: **0.1 USDC**, with the actual reviewed ceiling
  generally lower (`gasLimit × maxFeePerGas`). Total maximum **0.2 USDC** under
  the application's exact transaction constraints. Sufficient native balance
  for input plus the full reviewed fee budget is checked again before sending.
- The reviewed minimum output and slippage floor are unchanged. A revert may
  consume gas without producing EURC. Late approval/inclusion can still revert.
  A wallet that edits the reviewed transaction can exceed these app guarantees.

## Closing and rollback

Set `VITE_UNISWAP_ARC_PILOT_ENABLED=false` (or remove it), restore the source
release gate to `false`, and rebuild/redeploy **only with owner authorization**.
Alternatively restore the last approved preview-only deployment. Keep the live
quote API's existing configuration intact. Retain transaction records; do not
clear localStorage to retry an unresolved request. Cancel outstanding wallet
prompts, inspect existing hashes, and refresh/close old pilot tabs. Configuration
is build-time: this is **not an instantaneous remote kill switch**. Old tabs or
already-open wallet prompts cannot be revoked by a new deployment. Submitted
transactions cannot be rolled back; only their status can be followed.

## Exact security boundary

The wallet allowlist and feature flags are **client-side application restrictions,
not cryptographic authentication or an on-chain access control**. They do not
stop someone modifying the client, calling a public router independently, or
issuing multiple transactions across browsers/devices. No global single-use
guarantee is claimed. The controller rechecks its configured pilot authorization
before preparing and at every existing pre-send checkpoint; browser locks and
the journal retain their existing local duplicate protections. There is no new
server authentication, database, service or quota system. Quote access stays
unchanged and is not authenticated by this allowlist.

## Controlled verification

47 execution/security groups (the previous 40 plus 7 pilot groups), 16 Chromium
execution/pilot UI groups, 17 default Preview UI regression groups and 37 decoder
security groups pass. TypeScript, production build and lint pass. Browser tests
use public test wallet configuration and an in-memory release-gate transform;
the production source gate remains false. API/RPC/wallet responses are controlled
test doubles. No live quote, real signature, deployment or transaction is claimed.
