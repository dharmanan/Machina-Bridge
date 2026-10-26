# Dependency security review

## 2026-10-26: compatible Zod v3 collection backport

The application keeps Circle's pinned Zod 3 API. It does **not** force Zod 4
under packages using `z.function().returns()` or v3 record schemas.

The fix follows the semantics of the [upstream collection-size security
commit](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd),
for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5):
an oversized constrained collection is rejected before visiting elements or
running outer refinements. Array `.max()` and the upper bound of `.length()`,
and Set `.max()`/`.size()` are covered. Wrong types, valid inputs, lower bounds,
transforms, async parsing, function signatures and record validation keep the v3
API. V3 has no built-in bounded Map API; no artificial Map semantics are added.
This is not a general input-size limit or a guarantee against all parser DoS.

`scripts/apply-zod-collection-backport.mjs` applies the reviewed changes at
postinstall. `zod-v3-backport.json` pins original and patched SHA256 values for
the CJS/ESM parsers and Reown's UMD entry point. All 16 locked installations
(33 v3 parser files) are checked. Unknown versions, missing files, lock mismatch
or unexpected bytes fail installation. Every file is validated before writing;
rerunning is idempotent. `prebuild` requires all patched hashes, so an install
with skipped lifecycle scripts cannot silently produce an unpatched release.
Update/review the manifest when updating Zod; do not accept unknown bytes.

The backport **does not** rename packages, alter their versions, rewrite lockfile
integrity, dismiss advisories or suppress `npm audit`. Raw audit still reports
the upstream version range. Therefore a successful backport test is not called
a clean npm audit. The audit CI job remains blocking and unchanged.
The current raw production audit reports 25 high and 7 low affected-package
entries (exit 1). Zod's collection advisory remains in the registry metadata;
the separate elliptic advisory is not fixed by this patch.

Scope limitation: old Zod 3 packages also ship historical v4 subpaths; those
are not modified by this v3 backport. Production imports must not switch to
those historical v4 parsers. The separate current Zod 4.6.7 consumer retains
the official v4 fix; its v3 compatibility entry point is backported as well.
Unconstrained collections, malicious provider responses and general input-body
resource limits are separate concerns.

Regression verification includes every installed v3 CJS/ESM entry, Reown UMD,
oversized valid/invalid/sparse arrays, sets, async parsing, nesting, custom
messages, no element/refinement visits, valid v3 SDK function/record APIs, and
installer drift/unknown-version/missing-patch rejection. Full application
quality, module and Chromium regression outcomes accompany the delivery.

Rollback: revert this dependency patch and its install/build lifecycle changes,
then reinstall the unchanged lockfile. That restores the known vulnerable v3
behavior; it is not a security remediation. No automatic allowance, signature,
transaction or production-setting change is involved.

The earlier dated review below is historical. Its counts and test totals must
not be presented as the current audit.

## Historical review — 2026-10-22

Repository: `dharmanan/Machina-Bridge`; branch: `feature/uniswap-swap-preview`.
Reviewed parent: `329251bc5e0d6574df4ed63e4a224ba06ae3229e`.

## Result: partial remediation; NOT a clean audit

| npm audit scope | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before, all dependencies | 0 | 13 | 4 | 19 | 36 |
| After, all dependencies | 0 | 5 | 0 | 18 | 23 |
| After, production dependencies (`--omit=dev`) | 0 | 0 | 0 | 18 | 18 |

These are npm's affected-package counts, including dependency-chain propagation,
not counts of independent vulnerabilities. Two independent advisories remain.
Both final audit commands exit **1** because findings remain. No findings were
suppressed or dismissed. The accompanying JSON files are real npm registry audit
responses, rather than mocked results. An audit is a point-in-time dependency
advisory check, not proof that all application or infrastructure code is secure.

## Applied updates and reviewed Dependabot PRs

- [PR #52](https://github.com/dharmanan/Machina-Bridge/pull/52): reviewed the
  `follow-redirects` 1.16.0 → 1.16.1 lockfile change. Applied 1.16.1 with a root
  override so fresh resolutions preserve the fix.
- [PR #53](https://github.com/dharmanan/Machina-Bridge/pull/53): reviewed the
  Vite 8.0.16 → 8.3.5 manifest/lockfile update, including required build-tool
  dependencies. Applied the same Vite release within major version 8.
- Updated the existing Hono override from 4.13.7 to 4.13.13.
- Refreshed `package-lock.json` and verified a fresh `npm ci`. Third-party install
  hooks were disabled; the repository's own `fix-viem-tsconfig.mjs` was run.
- Existing Circle SDK, viem, wallet, React, Tailwind, and Postgres versions are
  unchanged. Application code, execution gates, pilot limits and environment
  configuration were not changed.

The two open bot PRs target **main**. They were inspected, not merged, closed or
modified. This feature-branch update does not close default-branch alerts.
The GitHub security-alerts endpoint was unavailable through the connector and
denied through the CLI; a complete Dependabot/CodeQL/secret-scanning alert list
could not be independently enumerated. No claim that GitHub's Security tab is
clear is made.

## Remaining blockers

1. **High, development dependencies:**
   [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
   `braces@3.0.3`, nested-pattern stack exhaustion. Tailwind 3.4.19 reaches it
   through `micromatch@4.0.8` and `chokidar@3.6.0`. The five high package entries
   derive from this advisory. npm reports `fixAvailable: false`; 3.0.3 is the
   latest published braces release at review time. It is absent from the
   production-only audit, but remains a real build/development dependency risk.
   A Tailwind major-version migration needs separate compatibility work and
   cannot be represented as a safe patch-only dependency fix.
2. **Low, runtime dependency chain:**
   [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84),
   `elliptic@6.6.1`, risky cryptographic primitive implementation. Circle's
   `@ethersproject/abi@5.8.0` dependency reaches Ethers v5 signing-key, which pins
   elliptic 6.6.1. The 18 low package entries derive from this advisory. npm
   reports `fixAvailable: false`; 6.6.1 is the latest published elliptic release
   at review time. The then-current Circle Swap Kit 1.8.1 and Viem Adapter
   1.19.2 still declare the Ethers v5 ABI dependency, so blindly upgrading those
   SDKs would not remove this blocker. The verified Swap Kit 1.7.0 and Viem
   Adapter 1.18.0 were preserved. Dependency presence is established; this
   review does not establish exploitability in Machina's wallet execution path.

Next safe step: obtain upstream fixes or separately review/test the required
dependency migrations. No audit exclusions, fake patched versions, arbitrary
cryptography substitutes or unreviewed dependency forks were introduced.

## Verification on the updated installation

All checks below passed:

| Check | Result |
| --- | --- |
| Frontend TypeScript and production build (`npm run build`) | PASS |
| Server TypeScript (`tsc --project api/tsconfig.json --noEmit`) | PASS |
| Lint (`npm run lint`, zero permitted warnings) | PASS |
| Uniswap execution/security | 61 groups |
| Uniswap decoder/security, including captured real calldata | 37 groups |
| Uniswap API security | 22 groups |
| Timing/error protocol | 8 groups |
| Chromium execution UI | 20 groups |
| Chromium automatic quote UI | 18 groups |
| Real local Vercel Node builder / native ESM Lambda loading | 8 groups |
| Circle Swap Preview | 25 checks |
| Borrow adapter / preview / write safety | 19 / 33 / 51 checks |
| Wallet Activity | Existing classification regressions + 16 Blockscout checks |
| Bridge Kit Solana/Arc support discovery | PASS |

Browser/API/RPC/wallet regression tests use controlled responses. Archived real
calldata is decoded offline. Local serverless checks use `@vercel/node@26.0.0`
on Node 24.19.0; this is not a live deployment test. Existing build warnings for
large chunks and browser externalization of `node:worker_threads` remain; build
exits successfully. No live quote, wallet signature, transaction, deployment,
service provisioning, main or Intelligence branch change was performed.
