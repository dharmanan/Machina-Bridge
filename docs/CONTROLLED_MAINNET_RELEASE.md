# Controlled Mainnet release — 26 October 2026

This release prepares the existing application for the user's live checks on
Production. It does not certify a successful live Borrow/Close cycle or fair
market prices. No real wallet signature or fund operation is part of CI.

## Release boundaries

- Bridge/Earn retain their existing runtime and execution configuration.
- Swap execution is source-restricted to
  `0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`, on Arc 5042, for the existing
  supported token pairs/providers. Quotes remain available to other wallets.
  No build value, including `VITE_SWAP_EXECUTION_MODE=open`, grants public
  execution in this source release. Address gating is rollout policy, not
  wallet authentication or a defense against arbitrary browser JavaScript.
- `VITE_UNISWAP_ARC_PILOT_ENABLED=false` or
  `VITE_SWAP_EXECUTION_MODE=off` disables Swap execution in a subsequent build.
  Malformed values fail closed. An absent mode selects only the source canary.
  Explicit `pilot` preserves the former approved-wallet Uniswap USDC/EURC
  0.1-USDC fallback. Existing explicit off settings are never overwritten.
- Public Borrow gates `MAINNET_BORROW_WRITES_ENABLED` and
  `MAINNET_BORROW_EXECUTION_BOUND` remain literal false. A separate source
  canary permits only the same address through an attested guarded official
  adapter. No flag disables batch decoding, simulation, fee binding, nonce,
  allowance, Morpho authorization/revoke or independent recovery checks.
- Borrow native EIP-5792 transport remains blocked: its API cannot enforce the
  reviewed outer transaction fee ceiling. The official 1.19.0 `/next` plain
  EOA path may be used only when discovered without rewriting capabilities,
  with a deployed sender-preserving batcher, no account delegation, complete
  atomic simulation, and the guarded explicit transaction fee fields.
  A MetaMask/WalletConnect connection alone does not prove compatibility.

## Independent price evidence — not complete

The official [Chainlink Arc announcement](https://dev.chain.link/changelog/added-support-to-data-feeds-443d5)
links USDC/USD, EURC/USD, ETH/USD and BTC/USD **Shared SVR** feeds. The full Arc
address catalogue/metadata could not be retrieved in this environment. No
unverified proxy or heartbeat is coded into the application.

Read-only Morpho oracle getters exposed candidates with `ETH / USD` and
`BTC / USD` descriptions and positive round data on Arc. These do not establish
the official four Shared SVR proxies, USDC/USD or EURC/USD prices, heartbeat,
or WETH/ETH and cirBTC/BTC market equivalence. They are not production oracle
configuration. A second-venue quote and successful simulation are not an
independent fair-price guarantee. Slippage/minimum-output checks constrain
execution relative to a quote, not the fairness of its initial price.

Therefore **general Swap execution is NO-GO**. The approved canary Review
explicitly discloses absent independent market-price verification. Users must
not infer that large-trade price impact or wrapped-asset backing is protected.

## User-run Borrow and complete-exit check

1. Use only the approved address on Arc, with a plain supported EOA transport.
   Capability, balances, market/oracle state and existing positions must be
   read afresh. An unsupported native atomic wallet is blocked, not converted
   to sequential approval/borrow operations.
2. Start with a small quoted borrow (for example 0.1 USDC, not a hardcoded
   allowance or automatic action). Fund only the collateral stated in the
   current Review, plus sufficient native USDC for both entry and exit gas.
   An earlier read found no required cirBTC collateral: do not assume funding
   or quote executability from a successful HTTP quote alone.
3. Choose an explicit maximum native-USDC gas budget in the form. It is a
   ceiling, not a price estimate. Each operation re-estimates the atomic call
   and binds gas/maxFeePerGas to this budget before the wallet opens. Reject
   wallet edits, additional fees, unexpected recipients or expired requests.
   No fixed illustrative fee is represented as a measured live gas estimate.
4. Explicitly confirm Borrow in the page and wallet only after reading the
   batch, collateral, debt, HF, LTV, service fees and deadline. Public and wallet
   latest/pending/latest nonce checks must reconcile. A storage, simulation,
   allowance or context failure blocks the request.
5. Keep the early hash and independently verified receipt/position result.
   If unknown/pending, use recovery; do not submit another operation. After
   confirmation, use Close Loan, or full Repay then Withdraw, with a new Review
   and separate explicit user confirmation. Reserve debt interest/buffer and
   exit gas. Verify zero debt, returned collateral, authorization revocation
   and real gas from canonical receipts/positions.
6. Until the actual provider and complete exit have passed these live checks,
   public Borrow is **NO-GO**. Controlled SDK/Chromium fixtures are not live
   Borrow proof. The application cannot stop a browser extension changing a
   wallet request after its own boundary checks.

## CI, publishing and rollback

Ordinary feature pushes run fast safety checks and preserve raw dependency audit
findings. A candidate commit tagged `[release-check]` runs the full source and
Chromium suites. In this release procedure their successful results on the
exact candidate SHA are required **before** integrating main. PRs targeting main
also run full acceptance. This does not assert that GitHub branch protection was
configured; no repository policy settings were changed.

After acceptance, integrate the unchanged verified feature tree into main and
push normally. The existing GitHub/Vercel integration builds Production; do not
invoke manual deployment, promotion or environment mutation. Preserve the prior
main SHA and record the resulting Vercel status linked to the new main SHA.
A GitHub Vercel success status is not proof of actual domain wallet behavior or
secret environment scope. Such inaccessible evidence must remain unverified.

To stop the Borrow canary, set `BORROW_CANARY.enabled` false in a reviewed source
change and normal main push; public gates stay false. Swap can be source-disabled
or rebuilt with the existing explicit off switch. Roll back application code by
normal revert/release of the recorded previous main tree, never force-push.
Rolling back to an older dependency tree may restore known vulnerabilities.
A deployment rollback cannot undo blockchain approvals, debt, pending requests
or confirmed transactions. Preserve local recovery records and resolve an open
loan safely before abandoning a canary. No automatic revoke or transfer occurs.

See [dependency security review](dependency-security/REVIEW.md) for partial Zod
mitigation, bounded SDK responses, raw audit findings and unprotected surfaces.
