# Unified Swap: four tokens, two providers, one screen

Arc Mainnet 5042. Tokens: USDC (native gas token, 6-decimal ERC-20 face), EURC, cirBTC, WETH. Providers: Uniswap (Universal Router) and
Circle Swap Kit. Twelve directions x two providers = 24 combinations. **The default build executes all 24** with any externally owned wallet, up to the
per-swap ceilings below. The earlier controlled pilot (approved wallet, native USDC → EURC, at most 0.1 USDC, Uniswap) remains only as an explicit build
fallback. Whether the build executes at all is decided by one switch, `VITE_UNISWAP_ARC_PILOT_ENABLED`, which must stay set deliberately in production.

## Build configuration (public, build-time; none of it is a credential)

| Variable / constant | Effect |
| --- | --- |
| `VITE_UNISWAP_ARC_PILOT_ENABLED=true` | Execution switch (the kill switch of the build). Anything else: quotes only ("Preview only"). |
| `VITE_SWAP_EXECUTION_MODE` | Unset or anything else: the **default, multi-direction mode** (every direction, both providers, any EOA wallet). The exact string `pilot` restores the earlier pilot. |
| `VITE_UNISWAP_ARC_PILOT_WALLET` | Only used by the explicit pilot; pinned to the approved address, a different value fails closed. |
| `CIRCLE_SWAP_WRITES_ENABLED` (`src/lib/swap/circleSwap.ts`) | Circle's own source gate: `true`, because every condition below is enforced. A failed condition closes a single swap, never the gate for the others. |

The default mode lifts only the *direction/wallet* restriction of the pilot; per-token ceilings in `ARC_INPUT_CAPS` still apply (10 USDC, 9 EURC,
0.00012 cirBTC, 0.004 WETH per swap, roughly 10 USD, while no route has been sent with a user's own wallet). No transaction check is relaxed in any mode. In the default
mode USDC → EURC uses the same keyless on-chain Uniswap route as every other direction, not the Trading-API route of the pilot.

## What the screen does

Pick any token and any other token; reverse; 25/50/75/MAX from the real balance (native USDC keeps a 0.1 USDC fee reserve); both providers quote
at the same time and are shown side by side with the better price tagged. The provider the user selected is never changed by the app. Review →
Confirm → wallet → "Verifying transaction" → "Swap completed" / "Swap failed", with the real received amount, the amount paid and the real fee. The Review shows
the amount paid, the estimate, the **minimum received**, the slippage, every fee (Uniswap: pool fee already inside the estimate, network fee ceiling, and the explicit statement
that nobody else takes a fee; Circle: Circle's fee, the network fee estimate and the ceiling over all steps) and the most USDC that could leave the wallet. Technical
details (contract, program, gas fields, fingerprints) are in a closed disclosure. One transactions panel shows the latest swap in full and every earlier record
(all wallets stored in this browser) as a closed list of one-line summaries that open on demand; records are never deleted and a swap that differs from its Review keeps its warning.
Calldata, program names (`TAKE_PORTION`, `SWEEP`, `V4_SWAP`) and check ids are not on the normal screen; they stay in each record's "Technical details" for support.

The status texts are plain English: *Confirm in your wallet*, *Verifying transaction* (do not send it again), *Swap completed* (amount sent, amount received, network fee),
*Swap failed* (the network rejected it; no tokens were swapped, only the network fee was charged), *Swap cancelled* (declined in the wallet). "Try again" is offered only
for those last two — a failure that is certain — and only sets the same swap up again: a fresh Review is still required and nothing is sent. A swap that happened, is being verified or
is unknown never offers it.

## Uniswap

* **Pilot route (USDC → EURC, explicit pilot build only):** Uniswap Trading API calldata through the server preview route, decoded by the legacy profiles. Unchanged.
* **Every route in the default mode:** a keyless provider. Pools come from a pinned V3 registry (`swap/uniswapPools.ts`, addresses derived
  from the pinned factory and init-code hash, checked against the live factory). A quote is a read-only `eth_call` of the real Universal Router against the
  real pools through a read-only simulation helper injected as call-scoped state (`scripts/contracts/SwapSimulator.sol`, reproducible with
  `node scripts/build-swap-simulator.mjs --check`; it is never deployed). The transaction is canonical calldata built locally and re-decoded byte for byte by
  `swap/uniswapRouteProgram.ts` before a wallet is asked: recipient = owner, registered pools only, no fee portion, no suffix.
* **ERC-20 input** needs two exact approvals (token → Permit2, Permit2 → router, 15 minutes), each its own Review and wallet confirmation (`swap/uniswapApprovals.ts`).
  Never unlimited. Native USDC needs none.

## Circle Swap Kit

The SDK runs unchanged but only ever sees a guarded wallet (`swap/circleGuard.ts`): an exact approve to the pinned adapter (or an exact EIP-2612 USDC permit),
then one adapter `execute` whose decoded intent matches the Review (`swap/circleAdapterDecode.ts`). Each step is confirmed in the app first, then in the wallet.

Conditions that gate every Circle swap (all fail closed; none is a flag that was only flipped):

* **Real service responses.** Fresh responses of Circle's service for all 12 directions were read (no wallet, no key, nothing sent) and pass the calldata policy; the fee instructions equal
  the quoted provider fee; the deadline and gas limit fit the ceilings.
* **Review-bound provider fee.** The provider fee in the Review (`maxFeeUnits`) bounds the fee instructions in the calldata (1% slack plus one unit of rounding); a larger fee is refused.
* **Independent price floor.** The Review carries a keyless Uniswap quote for the same amount. Circle's guaranteed minimum may not be more than the chosen slippage plus 2.5% below it
  (`independentPriceCheck`). With no independent price the Review cannot be executed.
* **Outcome simulation (exact-approval swaps).** The exact adapter calldata is simulated against the live adapter with the owner's balance and allowance overridden (`eth_call` state
  overrides); the simulated receipt must be at least the minimum and spend exactly the amount. USDC (permit) swaps cannot be simulated this way, because an owner with code switches the
  permit check to EIP-1271, so they rely on the other conditions and the on-chain minimum.
* **Pinned adapter** (proxy, implementation and both code hashes), EOA wallet only, balance, allowance and fee ceiling re-read right before each wallet request.

The calldata policy follows the shape of every sampled real Circle swap: fee instructions only on the FEE contract with the known call shape, exactly one swap instruction on the
EXECUTOR with the known entry point, instructions that add up to exactly the input amount, a bounded fee share, and the input *and* output token swept back to the wallet. The adapter is an
upgradeable ERC-1967 proxy, so its implementation address and that implementation's code hash are pinned next to the proxy's own hash; an upgrade closes Circle swaps until it has been
reviewed. The wallet below the guard is reachable through four requests only, and the guard forwards values it checked itself (never the SDK's own objects), re-checks the session, the
deadline and the wallet after every wait, and hands out its counters as snapshots.

## Verification: the chain and the Review are two answers

`swap/transactionEvidence.ts` compares the transaction that is on chain with the Review the user approved. Calldata, value, target, sender, nonce and chain are never
adjustable; wallet-edited gas fields are judged against the approved fee ceiling. Result:

* chain success **and** matches the Review → **Swap completed** (no warning)
* chain success but not the reviewed transaction → **Swap completed** with a warning card, "This swap differs from your review", in plain words with the amounts: a fee that was
  taken from the amount received (for example "A fee of 1.6% was taken from the amount you received. It was not part of your review."), a received amount below the reviewed minimum, a higher
  network fee than the ceiling, or — for any difference without its own wording — "The transaction your wallet sent was not exactly the one you reviewed." Stored status `mismatch`; never
  presented as verified, never offered again. The raw findings stay in the record's Technical details.
* chain success but one check could not be completed → **Swap completed** with "We couldn’t finish checking this swap against your review".
* reverted → **Swap failed** (fee shown, Try again). Read trouble → the last known status stays, with the reason; RPC trouble is never a chain failure.

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
completed on chain, with the warning that a 1.6% fee was taken that no Review contained; looked up by hash it shows what the network shows and states that it is not among the saved swaps.
The original Review record lives only in the user's browser and is never fabricated or reconstructed here.

## Evidence and tests

`node scripts/discover-swap-evidence.mjs` (read-only, `NODE_USE_ENV_PROXY=1` behind a proxy) rewrites `scripts/fixtures/swap/provider-evidence.json`.
Hermetic suites: `verify-swap-verification`, `verify-swap-uniswap-onchain`, `verify-swap-approvals`, `verify-swap-circle-execution`, `verify-swap-display`,
`verify-swap-support-matrix`, plus the updated Uniswap suites. Chromium suites (`CHROMIUM_PATH`, `PLAYWRIGHT_CORE_PATH`): `verify-uniswap-arc-ui`,
`verify-uniswap-arc-execution-ui` (explicit pilot build) and `verify-swap-unified-ui` (default mode, controlled Arc RPC and Circle doubles). Mock PASS is not production success.

## Known limits (reported, not hidden)

* Circle's quote service decides the reviewed minimum. The guard enforces that floor on chain, and the Review is refused when it is more than the slippage plus 2.5% below the independent Uniswap quote (or when that quote is unavailable). A Circle quote that is wrong by less than that margin is accepted.
* USDC-input Circle swaps (EIP-2612 permit) are not outcome-simulated before the wallet request; the on-chain minimum, the deadline and the fee ceiling still bound them.
* What the adapter does with each `minTokenOut` and the sweep list is checked from the calldata and from real receipts, not from the implementation's source.
* The public Arc RPC is the only evidence source for balances, nonces and receipts; one lying endpoint could only be bounded on chain by the minimum, the deadline and the fee ceiling.
* A hash-less record whose wallet request may still be answered (unknown) can only be resolved by supplying the hash; there is no "mark as abandoned" action by design.
* Journals and their archives share the browser's storage quota; a full archive refuses new records (fail closed) and has no pruning screen.
* Stored records are re-validated with the current rules; tightening a rule later needs a tolerant reader for tracking-only records.

## Not proven live

No real transaction of any route other than the one pilot swap has been sent by this application, and no approval or permit has been signed by it on these routes. The keyless Uniswap route
is verified against the live router/pools (read-only simulation). Circle was verified read-only against its live service for all 12 directions and by simulating one exact adapter call
against the live adapter; its approvals, signatures and swaps are verified with controlled doubles. What remains is the first real approval/permit signature and swap per route with a
user's own wallet, for each provider. That is a user action and is not shown as done anywhere in the app.
