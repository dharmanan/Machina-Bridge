# Unified Swap: four tokens, two providers, one screen

Arc Mainnet 5042. Tokens: USDC (native gas token, 6-decimal ERC-20 face), EURC, cirBTC, WETH. Providers: Uniswap (Universal Router) and
Circle Swap Kit. Twelve directions x two providers = 24 combinations. **The production build still executes only the controlled pilot**
(approved wallet, native USDC → EURC, at most 0.1 USDC, Uniswap). Everything else is quoted, built and tested, and gated.

## Build configuration (public, build-time; none of it is a credential)

| Variable / constant | Effect |
| --- | --- |
| `VITE_UNISWAP_ARC_PILOT_ENABLED=true` | Execution switch. Anything else: quotes only ("Preview only"). |
| `VITE_UNISWAP_ARC_PILOT_WALLET` | Pilot wallet; pinned to the approved address, a different value fails closed. |
| `VITE_SWAP_EXECUTION_MODE` | `pilot` (default; any value other than the exact string `open` means pilot) or `open`. |
| `CIRCLE_SWAP_WRITES_ENABLED` (`src/lib/swap/circleSwap.ts`) | Circle's own source gate. `false`. Circle is also never part of the pilot. |

`open` mode lifts only the *direction/wallet* restriction of the pilot (per-token ceilings in `ARC_INPUT_CAPS` still apply: 10 USDC, 9 EURC,
0.00012 cirBTC, 0.004 WETH per swap). No transaction check is relaxed in either mode. Opening it is a separate release decision.

## What the screen does

Pick any token and any other token; reverse; 25/50/75/MAX from the real balance (native USDC keeps a 0.1 USDC fee reserve); both providers quote
at the same time and are shown side by side with the better price tagged. The provider the user selected is never changed by the app. Review →
Confirm → wallet → Pending → Confirmed/Failed/Mismatch, with the real received amount, the amount paid and the real fee. One transactions panel
shows the latest transaction in full and every earlier record (all wallets stored in this browser) in a collapsed history; records are never deleted.

## Uniswap

* **Pilot route (USDC → EURC, pilot build):** Uniswap Trading API calldata through the server preview route, decoded by the legacy profiles. Unchanged.
* **Every other route, and every route in open mode:** a keyless provider. Pools come from a pinned V3 registry (`swap/uniswapPools.ts`, addresses derived
  from the pinned factory and init-code hash, checked against the live factory). A quote is a read-only `eth_call` of the real Universal Router against the
  real pools through a read-only simulation helper injected as call-scoped state (`scripts/contracts/SwapSimulator.sol`, reproducible with
  `node scripts/build-swap-simulator.mjs --check`; it is never deployed). The transaction is canonical calldata built locally and re-decoded byte for byte by
  `swap/uniswapRouteProgram.ts` before a wallet is asked: recipient = owner, registered pools only, no fee portion, no suffix.
* **ERC-20 input** needs two exact approvals (token → Permit2, Permit2 → router, 15 minutes), each its own Review and wallet confirmation (`swap/uniswapApprovals.ts`).
  Never unlimited. Native USDC needs none.

## Circle Swap Kit

The SDK runs unchanged but only ever sees a guarded wallet (`swap/circleGuard.ts`): an exact approve to the pinned adapter (or an exact EIP-2612 USDC permit),
then one adapter `execute` whose decoded intent matches the Review (`swap/circleAdapterDecode.ts`). Each step is confirmed in the app first, then in the wallet.

The calldata policy follows the shape of every sampled real Circle swap: fee instructions only on the FEE contract with the known call shape, exactly one swap instruction on the
EXECUTOR with the known entry point, instructions that add up to exactly the input amount, a bounded fee share, and the input *and* output token swept back to the wallet. The adapter is an
upgradeable ERC-1967 proxy, so its implementation address and that implementation's code hash are pinned next to the proxy's own hash; an upgrade closes Circle swaps until it has been
reviewed. The wallet below the guard is reachable through four requests only, and the guard forwards values it checked itself (never the SDK's own objects), re-checks the session, the
deadline and the wallet after every wait, and hands out its counters as snapshots.

## Verification: the chain and the Review are two answers

`swap/transactionEvidence.ts` compares the transaction that is on chain with the Review the user approved. Calldata, value, target, sender, nonce and chain are never
adjustable; wallet-edited gas fields are judged against the approved fee ceiling. Result:

* chain success **and** matches the Review → **Confirmed** ("Blockchain transaction successful · Matches your Review")
* chain success but not the reviewed transaction → **mismatch** ("Blockchain transaction successful — not verified against your Review", with the differences). Never Confirmed.
* reverted → **Failed**. Read trouble → the last known status stays, with the reason; RPC trouble is never a chain failure.

Polling: Pending is read every 5 s; a failed read backs off 5/10/20/40/60 s and stops after 8; a deterministic answer (terminal state, or a hash that does not identify the
attempt) is never retried automatically. The known status is never replaced while a lookup runs; only a small "Checking…" marker changes.

### Recovery and tracking

Nothing a user types is trusted until the network has shown it. A recovery hash is saved only when the node knows that exact transaction and it is bound to the attempt (sender, nonce, network); a
mistyped hash changes nothing. If a wallet speed-up or cancel replaced the recorded transaction, the recorded hash becomes unknown and its nonce is used by another transaction: only then does the app
offer to take the replacement's hash, and that hash is verified like any other (calldata, value, target, fee ceiling, minimum) before it is saved; the earlier hash stays in the status log.
A record with no wallet step and no hash (the page was closed before the first wallet request) proves that nothing was sent, and is closed instead of locking the wallet. A signature that fails moves no
funds and never locks the wallet. A flow that waits on the swap software with nothing open is ended after a while (the guard is sealed, so the SDK can send nothing afterwards). Records are moved to an
archive when a journal fills up, never deleted; an archived entry that today's rules cannot display is kept and counted. An unresolved record of either provider holds approvals, and the other way round.

### The first real swap (`0x1a5e6d2d…a921`)

On chain: success, block 27278158, 0.1 USDC → 0.087854 EURC, fee 0.003800899 USDC. Its calldata carries an extra 1.60% `TAKE_PORTION` of the output to a third-party address
(`0x147C…A566`) that no reviewed calldata of this application allowed, and the net amount is below the swap's own declared minimum. The app shows exactly that:
success on chain, not verified against a stored Review. The original Review record lives only in the user's browser and is never fabricated or reconstructed here.

## Evidence and tests

`node scripts/discover-swap-evidence.mjs` (read-only, `NODE_USE_ENV_PROXY=1` behind a proxy) rewrites `scripts/fixtures/swap/provider-evidence.json`.
Hermetic suites: `verify-swap-verification`, `verify-swap-uniswap-onchain`, `verify-swap-approvals`, `verify-swap-circle-execution`, `verify-swap-display`,
`verify-swap-support-matrix`, plus the updated Uniswap suites. Chromium suites (`CHROMIUM_PATH`, `PLAYWRIGHT_CORE_PATH`): `verify-uniswap-arc-ui`,
`verify-uniswap-arc-execution-ui` (pilot build) and `verify-swap-unified-ui` (open mode, controlled Arc RPC and Circle doubles). Mock PASS is not production success.

## Known limits (reported, not hidden)

* Circle's quote service decides the reviewed minimum. The guard enforces that floor on chain, but a quote that is wrong yet internally consistent is accepted; compare it with the Uniswap quote before opening Circle writes.
* What the adapter does with each `minTokenOut` and the sweep list is checked from the calldata and from real receipts, not from the implementation's source.
* The public Arc RPC is the only evidence source for balances, nonces and receipts; one lying endpoint could only be bounded on chain by the minimum, the deadline and the fee ceiling.
* A hash-less record whose wallet request may still be answered (unknown) can only be resolved by supplying the hash; there is no "mark as abandoned" action by design.
* Journals and their archives share the browser's storage quota; a full archive refuses new records (fail closed) and has no pruning screen.
* Stored records are re-validated with the current rules; tightening a rule later needs a tolerant reader for tracking-only records.

## Not proven live

No real transaction of any route other than the one pilot swap has been sent by this application. The keyless Uniswap route and all of Circle's execution are verified
against the live router/pools (read-only simulation), real on-chain fixtures and controlled doubles only. Circle's service responses are stubbed. A live test of each needs a
separate, explicit approval.
