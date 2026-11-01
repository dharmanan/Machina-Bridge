# Machina Bridge – Handoff to Sol (2026-11-01)

Labels: **[VERIFIED]** checked with a source · **[TOOL OUTPUT]** reported by a tool, still to be confirmed by Koray · **[INFERENCE]** interpretation, not proven.

Working rules that stay in force: commits only as `Koray <128939343+dharmanan@users.noreply.github.com>`, unsigned, no Co-Authored-By; no commit/push/deploy, real transfer, wallet signature or localStorage clean-up without Koray's explicit approval; Vercel deploys every push to `main` to Production.

---

## 1. Production state

| Item | State |
|---|---|
| Repository / branch | `dharmanan/Machina-Bridge`, production branch `main` → www.machinabridge.xyz (Vercel) |
| Current `main` | **`4863418`** – Arc → Solana recovery evidence fix (this handoff's parent) [VERIFIED] |
| Previous releases | `035c5fa` B2 Solana → Arc recovery · `2d042f2` B1 second-burn guard + verified "completed" · `bd43b16` phone fixes [VERIFIED] |
| Draft PR | [#54](https://github.com/dharmanan/Machina-Bridge/pull/54) `security/f1-solana-tx-policy` (`e11eaa5`) – G2 policy. **Draft, not merged** |
| Handoff branch | `fix/arc-solana-recovery-evidence` (this document only) |

## 2. Completed work

### B1 – Solana Bridge second-burn guard (in `main` since `2d042f2`)
- `src/lib/solanaSendGuard.ts`, `src/lib/solanaSendRuntime.ts`: persistent send journal (`machina_mainnet_solana_send_v1`) + Web Locks per EVM and Solana wallet; an unclear burn blocks new transfers until chain evidence settles it; no time-based unlock; manual review with warning.
- "Completed" is shown only when the receive is verified on the destination chain (Arc mint proof via `arcMintProof.ts` with source domain 5; Solana signature + used nonce). Otherwise "Receive verification pending".
- Tests: `verify-solana-send-guard` 17/17, `verify-solana-receive-verification` 6/6 [VERIFIED].

### B2 – Solana → Arc recovery (in `main` since `035c5fa`)
- `src/lib/solanaArcRecovery.ts`, `src/hooks/useSolanaArcRecovery.ts`, `src/components/SolanaArcRecoveryPanel.tsx`: verifies the Solana source (signed by the connected Phantom, CCTP invoked) and Circle's message (sender, recipient, amount, attestation); used Arc nonce = already received; otherwise one `receiveMessage` built by Machina after review + wallet approval; receive journal + Web Lock.
- Tests: `verify-solana-arc-recovery` 11/11; real device: "Already received" check worked [VERIFIED by Koray].

### Arc → Solana recovery evidence fix (in `main` since `4863418`)
Problem: the old recovery recorded every Circle SDK error (network, timeout, even a wallet rejection wrapped by the SDK as `KitError`) as `unknown` and blocked retries for good ("A prior wallet submission may still be pending").

Files: `src/lib/arcSolanaReceiveEvidence.ts` (new), `src/hooks/useMainnetSolanaCctp.ts`, `src/components/MainnetSolanaCanary.tsx`, `scripts/verify-arc-solana-receive-evidence.mjs` (new), `scripts/fixtures/arc-solana-pending-receive.json` (new, public Circle data), `scripts/verify-solana-bridge-ui.mjs`, `scripts/ci-suites.json`.

Behaviour:
- Journal `machina_arc_solana_receive_v1`: `walletRequestedAt` / `receiveRequestedAt` (real wallet request time; the Activity record keeps an old `createdAt` per source hash and is not used for decisions), `requestedBlockhash`, signed `signature` + `blockhash`, written **before** the signed transaction is returned to the SDK (if saving fails nothing is broadcast).
- Not sent = refusal before the wallet (no `walletRequestedAt`) or an explicit wallet rejection caught from Phantom's own error (4001 / "user rejected"). Everything else stays `unknown`.
- Settlement only from HTTP evidence: nonce via two readers (browser RPC list + `/api/solana-rpc`, confirmed + finalized), exact signature status, `isBlockhashValid`, re-read after expiry. Read failure or reader disagreement keeps the lock.
- Older records without evidence: four independent checks (nonce A, nonce B, no transaction ever touched the used-nonce PDA, no active wallet request) + risk warning + explicit checkbox; re-checked under the same Web Lock.
- Saved errors keep name/code/raw cause; URL queries, long hex/base58/base64 are scrubbed.
- `lastValidBlockHeight` is not available at signing time; blockhash validity is checked instead.

Tests (verified before push): `verify-arc-solana-receive-evidence` 14/14 (real pending message, fake Phantom/SDK, controlled chain; no burn), mutation check 4/4 caught, `verify-solana-bridge-ui` 10/10, `tsc`, eslint, `npm run build`, `verify-ci-coverage` 5/5, `fast` 18/18 and `full` 17/17 with the same code. The full `browser` group was stopped on Koray's instruction (not completed). PR #54 compatibility checked in a temporary worktree: real G2 policy + evidence signer compose; policy refusals leave no wallet request [VERIFIED].

## 3. PR #54 – G2 Solana transaction policy (Draft)
- Finding G2: Bridge Kit's Solana adapter loads programs with Anchor `Program.at`; Anchor 0.31.1 takes the program id from the RPC-supplied IDL (`idl.address`) without checking it. A manipulated RPC answer could redirect the burn/receive instruction while the user signs [VERIFIED code; exploit not executed]. On-chain IDLs are correct today [VERIFIED].
- Fix: `src/lib/solanaBridgeTxPolicy.ts` – `assertSolanaBridgeTransaction` with burn/receive policies (program ids, discriminators `bridge` / `receive_message`, account positions, fee payer, signers, amount, domain, recipient, destination caller, Kit fee = 0, max fee ≤ 1% of amount, event-account transfer = 3,900,000 lamports, compute budget ≤ 0.002 SOL, CCTP ALT only). Only `signTransaction` is given to Bridge Kit. Check runs before B1 marks `signing`.
- Tests 10/10, real mainnet burn/receive fixtures pass, falsified IDL refused; CI green on PR #54 [VERIFIED].
- Open in PR #54: ATA-creation and high compute-budget branches only policy-tested; fee ceilings are policy decisions; the recovery receive path in PR #54 would record a policy refusal as `unknown` — fixed in `main` by `4863418` (journal-based classification). When PR #54 is rebased onto `main`, resolve the recovery provider line as `createStrictSolanaProvider(createReceiveEvidenceSigner(phantomProvider, receiveEntryId), { kind: 'receive', owner, amountRaw: proof.fields.amount, exactMessage: attestation.message })`.

## 4. Open G1 – EVM side not checked before signing
The Arc side of the Solana Bridge (`increaseAllowance(0xB3FA…, amount)` on USDC and `bridgeWithPreapproval` on the Kit bridge contract `0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0`) still reaches the EVM wallet without a Machina pre-sign check (`createStrictEvmProvider` passes every request). G1 would have refused the 1.6% fee below (fee ≠ 0, feeRecipient ≠ Kit contract) [VERIFIED code path]. **HIGH, not fixed.**

## 5. Pending burn to recover
| Item | Value |
|---|---|
| Arc burn | `0x22e768dd2022c3b9316c0bc116b4e965a4595bf92fda222836aa6dd758a6c603` (2026-11-01 01:51 UTC, success) [VERIFIED] |
| Amount to receive | **0.0984 USDC** (98,400 µUSDC) to `B9srP1kSSU7UrRq8TiXg82cd65bkmo3fRSWzAAWpYS8A` = USDC ATA of Phantom `7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR` [VERIFIED] |
| Circle message | complete, nonce `0xa37c16c6…fa18`, feeExecuted 0, expiration 0 (no deadline) [VERIFIED] |
| Solana | used-nonce PDA `GqQBmNNn9AJ7XkbuDwmWk9XcNqYD7BKw8kDE9KPx9esi` not found (processed/confirmed/finalized), no signature history; no destination transaction; ATA balance 0.26088 (02:31 UTC) [VERIFIED] |
| Recovery proofs | `readCctpBurnProof` OK, `readBoundCctpAttestation` complete for this burn [VERIFIED] |

### 1.6% fee (Pocket Universe)
The burn's calldata had `amount 98400, fee 1600, feeRecipient 0x147CF09E7373B8FDA6f12021F1b0f98D6da1A566`; the Kit contract sent 0.00144 USDC to `0x147CF09E…` and 0.00016 to `0xbb994f71…`, burning 0.0984 [VERIFIED chain logs]. Machina code and the installed Circle packages contain no such fee [VERIFIED]. Koray reports the source as the **Pocket Universe** browser extension [TOOL OUTPUT – Koray's finding, not independently verified here]. Action: do Solana Bridge transactions without that extension; G1 must refuse such calldata.

## 6. RPC, journal, Phantom and blockhash findings
- "Network connection failed for Solana" is Circle `adapter-solana`'s label for **any** error whose text matches `/connection (refused|failed)|network|timeout|ENOTFOUND|ECONNREFUSED/i` (KitError 3001). The real cause of the reported failure is UNKNOWN (no raw error was saved by the old code; the new code saves it) [VERIFIED].
- SDK receive sequence: simulate (passed – Phantom opened) → Phantom `signTransaction` → SDK `connection.sendTransaction(skipPreflight: true, maxRetries: 0)` → `confirmTransaction` [VERIFIED].
- web3.js 1.98 confirmation needs a WebSocket: the HTTP status check runs only after the signature subscription is "subscribed"; HTTP-only endpoints end with `TransactionExpiredBlockheightExceededError` even when the transaction landed (local probe) [VERIFIED].
- `/api/solana-rpc` has no WebSocket (405); `solana-rpc.publicnode.com` has (101); publicnode accepts `sendTransaction` and CORS `*` [VERIFIED]. Recovery SDK stays on publicnode; Machina's own checks use HTTP.
- Phantom signing vs broadcast for the failed attempts: UNKNOWN; nothing landed and any signed transaction from those attempts has an expired blockhash [VERIFIED chain / INFERENCE protocol rule].
- A second receive cannot mint twice (used-nonce account) – worst case a network fee [INFERENCE: CCTP rule].

## 7. Recovery procedure (Production, no new burn)
1. Confirm Vercel Production serves `4863418` (or later) and Pocket Universe is disabled.
2. On www.machinabridge.xyz connect EVM `0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321` and Phantom `7bJT…8YQR`.
3. Solana Bridge → Arc → Solana direction → "Recover an older Arc → Solana transfer" → paste the burn hash.
4. The old `unknown` record has no saved evidence, so the review panel opens: all four checks must be ✓. Close any open Phantom request, tick the checkbox, "Unlock this receive", then "Recover existing burn" again.
5. Phantom must show only **+0.0984 USDC to `B9srP1kS…`**; anything else → reject and stop.
6. If an error appears again: do not clear storage; wait ~2 minutes and retry – the saved signature/blockhash are settled automatically.
7. Verify: used-nonce PDA `GqQBmNNn…` exists, ATA balance 0.26088 → 0.35928.

## 8. Open bugs, risks and missing tests
1. G1 EVM pre-sign check missing (HIGH).
2. Recovery SDK broadcast relies on one RPC (publicnode); repeated failures possible. Long-term: Machina broadcasts the signed receive itself to several providers and confirms over HTTP.
3. `/api/solana-rpc` and `/api/solana-read` have no CORS/rate-limit/body-size limits; allow `getProgramAccounts`/`sendTransaction` (MEDIUM).
4. Vercel deploys `main` without waiting for CI; pushes without `[release-check]` skip source/browser suites (MEDIUM).
5. Bridge Kit and Earn Kit telemetry enabled by default (wallet address, tx hash, amount to `api.circle.com`) (LOW).
6. Install scripts (keccak, bufferutil, utf-8-validate, postinstall) run in the Vercel build; no lockfile/install-script guard; no SBOM, secret scanning, SAST, scheduled audit, SECURITY.md (MEDIUM/LOW).
7. Circle packages have no npm provenance or repository link; `npm audit signatures` could not run here.
8. Known advisories: zod GHSA-mrhx (backport applied), elliptic GHSA-848j (low) – KNOWN LIMITATION.
9. Missing tests: real-wallet Arc → Solana recovery on Production; full `browser` group after `4863418` (stopped); real Phantom for PR #54 ATA / high compute budget branches.
10. `increaseAllowance` adds to the existing allowance; a rejected burn leaves allowance on the Kit contract (LOW).

## 9. Next tasks for Sol (in order)
1. Verify CI and Vercel Production for `4863418`; then run the recovery procedure (§7) with Koray.
2. G1: EVM pre-sign allowlist for the Solana Bridge (`increaseAllowance` spender `0xB3FA…` = amount; `bridgeWithPreapproval` amount, fee = 0, feeRecipient = Kit contract, domain 5, mintRecipient = Phantom ATA, destinationCaller 0, max fee ceiling; Arc `receiveMessage` recipient) – real calldata fixtures exist (`0x9c683a97…`, `0xb2099a7f…`, `0x22e768dd…` as a negative).
3. Rebase PR #54 onto `main`, resolve the recovery provider line (§3), re-run its suites; keep Draft until a reviewed real-wallet test.
4. Recovery broadcast resilience (multi-provider send + HTTP confirm).
5. Proxy hardening (§8.3), CI-gated deploy (§8.4), telemetry flags (§8.5), supply-chain checks (§8.6).
