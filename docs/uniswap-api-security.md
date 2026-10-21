# Uniswap production preview access

`/api/uniswap-arc-preview` is **disabled by default**. An absent or non-exact
`UNISWAP_ARC_PREVIEW_ENABLED=true` returns HTTP 503 with
`uniswap_arc_public_preview_disabled` before body parsing, API-key use or upstream
work. Only Vercel production (`VERCEL=1`, `VERCEL_ENV=production`,
`NODE_ENV=production`) can opt in. Preview/development/unknown serverless runtimes
stay closed even if the flag is set. Request headers cannot select this mode.

## Production configuration (owner action, not performed by this change)

- Leave `UNISWAP_ARC_PREVIEW_ENABLED` unset or `false` until the release is approved.
  To allow read-only quotes, set it to the exact string `true` in **Production**.
  Setting it back to `false` disables quotes in deployments using that environment.
  Vercel environment changes must be applied to the deployment; they do not mutate
  an already-running deployment's environment.
- `UNISWAP_ARC_ALLOWED_ORIGIN=https://machinabridge.xyz` must exactly match the
  browser Origin: HTTPS, no trailing slash, path or wildcard. Other site origins
  are rejected. Codespaces rewritten-Origin exceptions never apply in production.
- Keep `UNISWAP_TRADING_API_KEY` server-only. None of these variables use a `VITE_`
  prefix. Never place the key in the repository, browser, response or logs.
- The owner reports a Vercel Hobby production Firewall rule for this endpoint:
  **30 requests per IP per 60 seconds**, over-limit action **HTTP 429**. This
  account configuration was not independently inspected or changed here. Ensure
  the rule covers the deployed endpoint, including any routing aliases.

No environment variable enables Swap, approval, Permit2 or transaction signing.
`UNISWAP_ARC_WRITES_ENABLED=false`, `MAINNET_SWAP_WRITES_ENABLED=false`,
`writesEnabled=false`, and `executionBound=false` remain unchanged.

## Preserved protections and limits

- POST-only, exact Origin/JSON checks, an 8 KiB request limit, strict route/amount
  validation before preparation, and sanitized errors with no upstream payload.
- Existing CLASSIC Arc 5042 forward-route policy, pinned router/runtime hash,
  independent calldata/economic validation, balance/fee checks, read-only RPC
  simulation and quote freshness binding remain unchanged.
- The retained **20 preparations/minute per instance** and **two concurrent
  preparations per service instance** provide backpressure. HTTP 429 from the
  local preparation counter includes `Retry-After: 60`. Invalid input does not
  consume that counter. Existing upstream/RPC timeouts and no-retry policy remain.
- The unified Swap UI, Circle source and wallet connection experience are
  unchanged. Disabled production access still has an explicit UI message.
- Private Vite development remains available without the production flag. Its
  exact Codespace/runtime/port-bound proxy exception stays development-only;
  publicly forwarding the Vite port does not provide production Firewall coverage.

These are **abuse-reduction controls, not authentication or a global quota**.
Origin headers and wallet addresses can be forged outside a browser. Distributed
IPs, multiple instances/regions and cold starts can exceed per-IP/per-instance
limits. Vercel documents regional Firewall counters. No daily 200-call guarantee,
single-person guarantee or total infrastructure-cost cap is claimed.

The Uniswap Trading API is currently free with a default 6 requests/second per
key. Vercel function execution, bandwidth and RPC usage remain resource/plan
risks; Hobby allowances and upstream limits are not a universal zero-cost or
availability guarantee. A distributed attacker can exhaust capacity or quotas.
No Redis, Upstash, database, SIWE, BotID, dependency, subscription or new service
is introduced. No billable operation or deployment was initiated.

## Verification

Run `node scripts/verify-uniswap-arc-api-security.mjs`,
`node scripts/verify-uniswap-arc-preview.mjs`,
`node scripts/verify-uniswap-arc-timing.mjs`,
`node scripts/verify-uniswap-arc-ui.mjs`, API TypeScript, production build and lint.
HTTP/RPC responses and wallet connectors in these tests are controlled test
doubles. They verify the enabled handler and security/UI behavior; they do not
prove live Vercel Firewall enforcement or new live Uniswap quotes. Original
economic calldata evidence remains unchanged. No actual wallet signature or
blockchain transaction is performed.

Only the existing feature branch is updated. Main, Intelligence, Circle Bridge,
Earn, Borrow and Railway are unchanged. The production opt-in is not set by this
commit, and no production deployment is performed.

Sources:

- [Uniswap API limits and pricing](https://developers.uniswap.org/docs/trading/swapping-api/faqs)
- [Vercel WAF regional rate limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
