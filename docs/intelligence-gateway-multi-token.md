# Gateway multi-token compatibility and controlled repair

This change analyses Gateway events; it never submits a wallet transaction. CCTP, Swap, scheduler, RAM settings and the discovery retry index definition are unchanged.

## Units and event semantics

The existing verified registry (`api/_lib/arc-intelligence/assets.js`) agrees with the official [Arc contract list](https://docs.arc.io/arc/references/contract-addresses):

| Asset | Arc Mainnet token | Event decimals |
| --- | --- | --- |
| USDC | `0x3600000000000000000000000000000000000000` | 6 (ERC-20 interface, not native 18) |
| EURC | `0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1` | 6 |
| cirBTC | `0x171a4217b86a807a64eb94757db6849fb4bdbaa0` | 8 |

Only those three registry assets are accepted. An unknown token, noncanonical event, wrong wallet/minter emitter or unverified contract still fails the Gateway family. Deposited counts deposited value; GatewayBurned counts the Arc source leg and separately records its fee; AttestationUsed counts the Arc destination leg. WithdrawalInitiated counts an initiation only; WithdrawalCompleted records the withdrawn amount. A same-domain burn remains a source-leg event, not proof of another chain's completion. The existing event definitions and semantics are retained; the [official Circle contract repository](https://github.com/circlefin/evm-gateway-contracts) documents the wallet/minter contracts.

All raw amounts use BigInt arithmetic and decimal strings. The original fourteen fields, including their counts, domain tallies and uniques, remain **USDC only**. If another supported token has activity, the same JSON contains an optional `tokenMetrics: { version: 'circle-gateway-token-metrics-v1', byToken: { [address]: metrics } }` extension. Each address has independent counts, amounts, domain tallies and hourly uniques. Unknown extension versions/tokens and a USDC extension that disagrees with the original fields are rejected.

Windows sum each token independently; hourly uniques are not added. Read responses annotate decimals/symbols from the verified registry and report legacy-USDC-only versus multi-token hour coverage. No EURC/cirBTC amount is assigned a dollar value. Existing Gateway USD fields remain explicitly scoped to USDC. Gateway legs, other protocol flows and canonical asset transfers must never be added into one volume.

## Backward compatibility and rollback

Schema stays **2** and the family version stays `circle-gateway-arc-leg-v1`. No table, index, startup migration, checkpoint reset or historical backfill is added. Successful USDC-only hours retain the original JSON/hash, including on replay. Existing rows are never rewritten merely to add the extension. The new reader accepts the old representation; old readers/writers can still read the original USDC fields and ignore the extension. Tests exercise the actual c6352e baseline reader/writer against a new multi-token database, plus new readers against legacy fixtures.

Code rollback does not require a database rollback or removal of the extension. An older collector will again reject future non-USDC events as unavailable; it cannot provide multi-token coverage. Do not erase successful repaired hours, edit SQLite/WAL manually, drop the discovery index, reset checkpoints or run an index migration as part of this release.

## Three-hour repair — NOT run by this task

Targets are exactly `2026-10-22T18:00:00.000Z`, `2026-10-22T19:00:00.000Z`, `2026-10-22T20:00:00.000Z`. The supplied first-event transaction references are not complete hourly data and are not used as hourly totals.

After separate operator approval and an approved release/backup procedure, use the existing `scripts/repair-compact-gateway-hour.mjs` **once per exact target hour**, with the existing `COMPACT_SQLITE_PATH` and RPC pacing settings. It acquires the existing exclusive writer lock; a live writer must never be bypassed or its lock deleted. No schema/index migration is needed. Do not use the full-hour runner, backfill or discovery migration to repair these records.

For each hour `repairStoredGatewayHour` reads only that stored block range's complete Gateway stream, validates event headers and transaction/log positions, checks wallet/minter code and verifies stored block/hash/time boundaries before and after reads. The existing bounded RPC/event-block budgets remain enforced; exceeding them leaves that hour unchanged and requires separate review, not relaxed limits. Only an unavailable Gateway row can be upgraded. The family row/hash and append-only `family_repair_evidence:gateway:<hour>` metadata (original stored reason plus canonical hour/hash evidence) commit atomically. A failed write rolls both back. Checkpoint, other families, valuations, projections and discovery index are unchanged. Already successful hours are never recounted.

Atomicity is **per hour**: stop at the first failure; an earlier successfully repaired hour remains committed and an attempted failed hour stays unchanged. Re-running a successful hour is a no-op. The preserved durable evidence is the original stored reason and canonical boundaries; previously unpersisted raw RPC diagnostics are not invented. Keep the supplied original transaction evidence with the operational incident record.

The deterministic `gateway_unexpected_token` retry breaker stays disabled: service startup, restart, discovery and catch-up do not automatically initiate these three repairs. Verify the exact repaired rows, token units, original-reason metadata and unchanged checkpoint/other-family hashes before closing the incident.

## Verification in the isolated development environment

Relevant offline checks passed: protocol regression suite **18/18**, Gateway-focused completion/repair/compatibility suite **11/11** (real `node:sqlite`, including the actual c6352e reader/writer), targeted read-model/API regressions **9/9**, dashboard regressions **3/3**. The changed TSX file passed ESLint. General TypeScript and the production build passed after installing the already-declared `@circle-fin/borrow-kit@1.0.0` into an isolated dependency directory; its integrity matches the repository lock. Neither dependency manifest nor lockfile changed. Build output contains third-party PURE-annotation warnings; build exit status is zero. These are development fixtures/build checks, not a live Production repair or live dashboard validation.

## Release blocker

GitHub's status for base `c6352e06cca6d5effa6f4f336f402531cada0006` includes a successful `blissful-mercy - machina-intelligence` deployment targeting the Railway Production service. A feature-branch push therefore carries an automatic Production deployment risk. This task does not push or change Railway settings. An operator must separately prevent/approve that deployment path before an eventual push/release. Production access, repair, backup, restart and deployment were not performed here.
