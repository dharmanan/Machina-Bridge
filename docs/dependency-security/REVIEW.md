# Dependency security review — 2026-10-22

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
