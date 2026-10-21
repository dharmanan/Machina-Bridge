# Uniswap API access and quota boundary

Public Uniswap preview is **not ready to enable in production**. The default
`/api/uniswap-arc-preview` serverless handler returns HTTP 503 with
`uniswap_arc_public_preview_disabled` before reading the API key, parsing the
body, or calling the preparation service. There is no environment/header switch
that opens this entry point. This is an intentional safety closure, not a claim
that an unauthenticated public API has been protected by Origin checking.

## Findings and changes

- Origin, Referer, Fetch Metadata and forwarded headers are browser consistency
  checks. A non-browser caller can supply them. Neither an arbitrary wallet
  address nor the freshness UUID authenticates or authorizes a paid API user.
- The old Codespaces rewrite exception was present in the public handler. It is
  now reachable only through Vite's development adapter, with `NODE_ENV=development`
  and no Vercel runtime markers. It additionally requires the actual server-side
  `CODESPACES=true`, Codespace name, forwarding domain and exact matching port,
  allowed Origin, forwarded host, Referer and same-origin metadata. Headers alone
  cannot select development mode. No wildcard Origin or production exception.
- The default handler remains closed in production, preview, development and
  unknown environments. Even an accidentally exported development handler refuses
  production/unknown NODE_ENV or any Vercel runtime marker.
- Vite development still supports existing read-only previews and freshness
  headers. **The Vite port must remain private/authenticated by its host.** Its
  header checks do not make a publicly forwarded Codespaces port quota-safe.
  Port visibility/access settings were not inspected or changed by this commit.
- The retained 20/minute counter and two-preparation concurrency limit are
  process-local backpressure, not a global quota or billing guarantee. Instances,
  regions and cold starts have independent state. Invalid/oversized/unsupported
  input is now rejected before consuming the development preparation budget.
- The frontend reports intentional public closure explicitly and continues to
  offer the existing Circle source. It does not fabricate a quote or silently
  change provider. No Circle code or economic decoder was changed.

## Options without a new service

Existing Vercel DDoS protection and custom deny/IP rules can reduce exposure;
they do not authenticate public preview users or impose a global Uniswap budget.
Vercel documents a Hobby WAF rate-limit allowance, but plan/usage conditions must
be verified for this project. Its counters are per-region and source-based: an
IP rule alone does not bound a distributed attack's total paid API use. No WAF
rule, billing setting, subscription or production deployment was changed here.

Before reopening, implement and verify a non-spoofable authorization boundary
with enforceable aggregate paid-call limits, or a verified provider/platform
hard quota meeting the required threat model. Anonymous token issuance, a secret
embedded in frontend code, header allowlists and per-instance counters do not
meet that requirement. Existing upstream key restrictions/hard caps were not
accessible or verified. No new authentication/signing flow, Redis or database
was introduced.

Sources reviewed:

- [Origin header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)
- [Vercel WAF rate limits and regional scope](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
- [Vercel WAF free and priced features](https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing)
- [GitHub Codespaces environment variables](https://docs.github.com/en/codespaces/developing-in-a-codespace/default-environment-variables-for-your-codespace)

## Validation and scope

Run the focused API security suite, existing 37 decoder/security and 8 timing
groups, Chromium UI suite, API TypeScript, production build and lint. All API/RPC
responses and wallet connectors in these tests are controlled test doubles;
they prove handler/control behavior, not live Vercel WAF deployment or new live
Uniswap quotes. Economic calldata fixtures remain the original uploaded bytes.

API keys remain server-only, bounded errors are sanitized, and no raw upstream
error payload is logged. `UNISWAP_ARC_WRITES_ENABLED=false`,
`MAINNET_SWAP_WRITES_ENABLED=false`, `writesEnabled=false`, `executionBound=false`.
No actual wallet signature, approval, Swap or transfer is enabled. Package/lock
files, Circle Bridge, Earn, Borrow, Intelligence and Railway are unchanged.

This commit targets only `feature/uniswap-swap-preview`. Until this code is
deployed through a separately authorized release, it does not alter or secure an
already-running production deployment. No production deployment was performed.
