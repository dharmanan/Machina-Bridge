# Uniswap Arc execution — restricted pilot, activation pending approval

This implements native USDC -> EURC (CLASSIC V4) and native USDC -> cirBTC
(CLASSIC V3) for Arc Mainnet 5042. Circle remains preview-only. No reverse route,
approval, Permit2 signature, arbitrary token/router or additional provider exists.

The initial pilot additionally restricts execution to one configured wallet and
USDC → EURC at most 0.1 USDC. cirBTC remains preview-only in the application.
Both the existing source release gate and the new default-off pilot configuration
must permit execution. See [pilot opening/closing procedure](uniswap-pilot.md).

## Release boundary

`UNISWAP_ARC_WRITES_ENABLED` in `src/lib/uniswapArcPolicy.ts` is **true** for the
restricted pilot release. Preparation and confirmation additionally enforce the
default-off pilot configuration, pinned approved wallet, EURC direction and
0.1-USDC input ceiling. Missing or incorrect configuration fails closed. URL,
localStorage, DOM state and preview objects cannot bypass those application checks.
The server's existing `UNISWAP_ARC_PREVIEW_ENABLED` controls quotes only.
`MAINNET_SWAP_WRITES_ENABLED` remains false. API/preview reviews still report
`writesEnabled=false` and `executionBound=false`; these are never send authority.
No deployment, environment change, real signature or mainnet transaction was made.

## Review, confirm, send

1. **Review Swap** fetches a fresh quote using the existing same-origin API and
   monotonic/server-time freshness protocol. It never promotes an old UI preview.
   Existing 10 USDC input, 0.1 USDC maximum network fee, 100 bps slippage, router
   runtime hash, command/action/refund/suffix/recipient and minimum-output policies
   remain unchanged.
2. Quote freshness remains **30 seconds**, checked again immediately before the
   wallet request (with at least 5 seconds remaining). It authorizes opening that
   request, not extending or reusing an expired quote for a new request. The only
   calldata change is an execute deadline capped at **120 seconds from quote
   request start**, never later than Uniswap's original deadline. Commands, input bytes, native value and the exact 22-byte
   `unix` attribution suffix are retained and independently decoded again.
   The altered transaction is separately simulated. No deadline is extended.
   At least 30 seconds for wallet approval plus a 15-second inclusion buffer must
   remain before opening the wallet. An earlier original deadline is never extended
   to meet that budget: insufficient time requires a fresh review. The UI shows
   separate review expiry and transaction deadline, plus the approval budget.
3. Fixed, read-only Arc RPC independently rechecks chain, router/output contracts,
   output decimals, EOA code, current and pending USDC balances, current/base gas
   prices, exact calldata simulation, gas estimate and nonce state. Contract and
   EIP-7702 delegated wallets fail closed; their execution semantics are unsupported.
4. The review dialog shows pay/estimated/minimum output, slippage, network and total
   spend ceiling, recipient/router and validity. Cancel or a changed wallet,
   connector, network, amount, provider, slippage or hidden page invalidates it.
5. **Confirm Swap** refers only to an opaque ID for a private in-memory intent.
   Rendered objects and stored reviews cannot supply a transaction to this method.
   The same intent is resimulated and rechecked. A mutually confirmed nonce change,
   changed fees or expiry invalidate the review. No silent re-quote, nonce rebase
   or economic mutation occurs after confirmation.
6. A per-wallet Web Lock is acquired, unresolved attempts are checked, wallet
   `eth_chainId`/`eth_accounts`/nonce state are independently checked, and a durable
   intent is written and read back **before** the wallet request. There must be at
   least five seconds of verified validity left immediately before that request.
7. Exactly one `eth_sendTransaction` contains the verified native value, calldata,
   sender, router, chain, nonce, gas and EIP-1559 fee caps. No signing-message,
   typed-data, raw-send, batched-call, approval or account-request action is used by
   the execution path. The existing connected wagmi connector supplies the provider.

## Nonce agreement before any wallet transaction request

Review and Confirm both use the full public-RPC preflight and independently read
the connected wallet RPC. Each source brackets its `pending` nonce with two
`latest` reads. Both snapshots must be valid, stable, mutually identical and
`pending == latest`; otherwise no nonce is available for this pilot. A pending
transaction reported by either source blocks sending, including replacements.

One bounded recheck may repeat the **entire** preflight after a valid but moving
or conflicting snapshot. It cannot discard a higher observed nonce, silently
change the reviewed nonce, re-quote, extend quote freshness, or bypass simulation,
balance/gas/router/identity checks. Malformed or unavailable nonce responses fail
at their source stage. Confirm must still match the nonce retained during Review.
Wallet network/account identity is checked before and after its nonce reads.

Review/Confirm errors distinguish a real agreed nonce change, pending activity,
public/wallet disagreement, backwards observations, and unavailable public/wallet
nonce state. Validated integer counts can be shown; raw provider errors cannot.
An RPC mismatch is not resolved by endlessly repeating Review. No public RPC can
prove absence of transactions invisible to both nodes, and external activity may
occur after the final check; this is not global mempool visibility or atomic nonce
reservation. Existing local lock/journal and exact nonce/hash binding remain.

For this revision, a live read-only query returned Arc chain 5042 and public
`latest=12`, `pending=12` for the pilot address. The connected production wallet
RPC was unavailable in this environment, so its actual response and the live
production failure were not reproduced. Browser/RPC/wallet regression cases use
controlled responses; no real transaction or wallet signature was requested.

Nonce revision verification: 61 execution/security groups and 20 Chromium
execution/UI groups pass, including normal consensus, confirmed nonce changes,
pending activity on either/both nodes, transient convergence, persistent conflicts,
backwards observations, malformed responses and expiry during reconciliation.
TypeScript, production build and lint pass.

## Wallet provider compatibility and safe diagnostics

The execution hook now calls the connected connector's `getProvider()` **without
`chainId`**. In the installed `@wagmi/connectors` WalletConnect implementation
(`src/walletConnect.ts:316–346`), supplying `chainId` invokes `switchChain` before
returning the provider. Injected and MetaMask implementations use a different
provider acquisition path. Review must inspect the already connected provider,
not trigger a network-switch request. Its `request` receiver is preserved.
The installed WalletConnect EthereumProvider's actual request implementation is
also exercised against a controlled signer to verify active `eip155:5042`
routing. This test does not establish a live WalletConnect session's availability.

`uniswapArcWalletRpc.ts` reports fixed stages for provider acquisition, the
before/after chain and account checks, and latest-before/pending/latest-after
nonce reads. EIP-1193 and JSON-RPC numeric codes are recognized from a bounded,
cycle-safe error chain; arbitrary provider messages, names, stacks, URLs and
payloads are neither logged nor surfaced. Rejection (4001), unauthorized (4100),
unsupported methods (4200/-32601), disconnection (4900/4901), invalid requests,
RPC errors, unknown errors, invalid responses and timeouts remain distinct.
Provider acquisition is bounded at five seconds and each read at three seconds.
A late read cannot authorize execution. These timeouts never apply to the actual
wallet transaction approval window.

Only valid hexadecimal EIP-1193 quantities within the safe integer range are
accepted. Numbers, JSON-RPC envelopes, padded/unsafe quantities and unavailable
pending data fail closed. Network/account changes, unstable observations, real
nonce changes, pending activity and disagreement between sources remain blocked.
No alternate endpoint, latest-only fallback, automatic chain switch, permission
request or signing call is introduced. WalletConnect may internally route reads
through its configured HTTP provider; these observations are not proof of a
wallet's private mempool or globally complete pending-transaction visibility.

**Live root cause remains unconfirmed.** The earlier broad `wallet_nonce` catch
was proven to erase the failing RPC stage and code. The connector's network-switch
side effect is proven in installed source, but is not established as the cause of
the reported live nonce failure. No connected production wallet/session was
available here. A real unsupported or unavailable pending-nonce RPC remains
BLOCKED; passing controlled tests is not a live resolution claim. This revision
passes 71 execution/security groups, 21 Chromium execution UI groups, 18 automatic
quote UI groups, 37 decoder groups and 22 API security groups, plus TypeScript,
production build and lint. Pilot settings,
0.1 USDC maximum and all economic/preflight/submission guards are unchanged.

## Recording and chain results

- Records are bounded, versioned, wallet-scoped localStorage data (20 attempts,
  maximum 1 MiB). They contain public unsigned transaction details, not API keys or
  signed transactions. Corrupt/unwritable storage blocks new submission.
- A valid hash is shown immediately and persisted before receipt lookup. Later
  RPC/storage failure retains the in-memory hash and a durable unresolved intent.
  If storage fails after broadcast or the page dies before receiving the hash,
  recovery requires checking the wallet; the application cannot guarantee a hash
  that the wallet never returned. **It never automatically resubmits.**
- Wallet rejection (4001), ambiguous submission, Pending, Confirmed and reverted
  Failed are distinct. RPC errors/timeouts/missing receipts are not Failed. An
  unresolved request blocks another swap for that wallet in this browser origin.
- Reload reconnects read-only tracking, including while the write gate is closed.
  Stored terminal status is rechecked against chain data. A missing hash can be
  supplied from the wallet and is accepted only after exact transaction verification.
- Confirmed requires transaction hash/from/to/value/calldata/nonce/chain/type/gas
  and fee binding; matching canonical receipt block, two observed blocks; fee
  within ceiling; and correctly scoped, unique output Transfer logs showing net
  receipt >= the approved minimum. A reverted receipt is Failed. A reorg returns
  to Pending. Arc Explorer links are pinned to `https://explorer.arc.io/tx/`.
- Terminal results invalidate only the relevant Arc wallet USDC/output balance
  queries. No Bridge, Earn, Borrow, Intelligence or Railway code changes.

## Limitations and release checks

This is a tested execution candidate, **not a live-wallet/mainnet certification**.
Before enabling it: independent review, owner release approval and controlled
validation of the actual deployed connector + RPC flow are still required. No
production deployment or first funded transaction is authorized by this change.

- Web Locks and usable localStorage are required. They coordinate this origin's
  tabs, not different browsers/devices/origins, cleared storage or private sessions.
  There is no distributed exactly-once or single-person guarantee.
- Wallet software ultimately controls signing. The application supplies bounded
  parameters and rejects mismatched returned transactions; it cannot undo a
  broadcast by a compromised wallet/provider, or protect users who edit wallet fees
  beyond the reviewed ceiling. Such results remain unverified and are not retried.
- Once a wallet request is open it cannot be forcibly cancelled by changing the
  page/network. The supported approval window ends 15 seconds before the transaction
  deadline (at most 105 seconds from quote start, shorter when time was spent
  reviewing/checking). The timer changes Awaiting Wallet to Unknown and tells the
  user to cancel the request, not approve it or resubmit. It durably retains the
  unresolved intent and keeps the browser lock and response observer until the
  provider settles; an outstanding provider promise is not forcibly cancellable.
  Hash recovery/status controls become available once that request settles, or
  after a reload; a late hash is still recorded and verified even after deadline.
  A timeout never means Rejected or Failed. Browser suspension can delay the UI
  timer. The inclusion buffer is not an inclusion guarantee: delayed approval,
  mining or a price move can still cause a revert consuming gas. The reviewed
  minimum-output, slippage and refund constraints stay unchanged and on-chain.
- Dropped/replaced/cancelled transactions without an independently verified matching
  hash stay unresolved. No timeout is treated as permission to retry; replacement
  fee/payload changes are not silently accepted. Manual wallet/chain review may be
  necessary. Two observed blocks are not an absolute no-reorg guarantee.
- The existing Vercel IP rule and per-instance quote budgets are not global API or
  infrastructure-cost caps. Additional execution checks use the existing public
  Arc RPC; outages/rate limits block execution. No paid service is introduced.

## Controlled verification

`verify-uniswap-arc-execution.mjs` covers both actual calldata profiles, preparation,
explicit wallet requests, rejection/ambiguity, duplicate prevention, storage faults,
reload/recovery, economic/fee/nonce/receipt/output/reorg failures and gate closure.
The deadline revision additionally covers unchanged economic bytes for both routes,
original deadline caps, insufficient approval budget, quote expiry during final
simulation, 45-second approval, cutoff/late hash, and rejection after cutoff.
`verify-uniswap-arc-execution-ui.mjs` runs the real React/wagmi UI/controller/RPC
adapter, native Web Locks and localStorage in Chromium. Only an in-memory test
transform opens the release gate; HTTP/RPC and wallet responses are synthetic.
Original evidence bytes are unchanged. The earlier verification results below are
historical; see the pilot procedure for current release configuration and results.

A separate live **read-only** Arc RPC batch observed chain 5042, block 27180521,
base fee 20000000000 native base units, and router runtime hash
`0x2e80a35dc8a1da121611acc5c31be03c2e63669135461e63947901ecf8a1654d`.
Only `eth_chainId`, `eth_getBlockByNumber` and `eth_getCode` were called. This
confirms network/router identity, not a live quote, wallet integration, shortened
calldata simulation or successful swap. All send/result tests remain synthetic.

Existing decoder, API security, clock/freshness, default-preview UI and actual
Vercel Lambda ESM packaging suites, API/client TypeScript, build and lint are also
required. These tests do not call live Uniswap, request a real signature or send
any blockchain transaction.

Verification results for the deadline revision (all controlled, no live calls):

| Check | Result |
| --- | --- |
| Execution/security | 40/40 PASS |
| Chromium execution flow, persistence and mobile dialog | 15/15 PASS |
| Existing independent decoder/economics | 37/37 PASS |
| Existing freshness/error protocol | 8/8 PASS |
| Client/API TypeScript, production build, lint | PASS |

Unchanged suites previously passed on parent `ad6f57c`: API security 22/22,
default unified Preview UI 17/17, Circle Preview/SDK/DOM regressions 25/25 and
actual Vercel Lambda/native ESM packaging 8/8. They were not rerun for this narrow
deadline revision. No live wallet, Uniswap request, RPC simulation or deployment
was performed for this revision. The read-only RPC observation above is historical.

References:

- [Universal Router deadline](https://github.com/Uniswap/universal-router/blob/main/contracts/UniversalRouter.sol)
- [Arc native/ERC-20 decimal model](https://www.arc.io/blog/arc-compatibility-guide-for-existing-evm-apps)
- [EIP-1193 provider requests](https://eips.ethereum.org/EIPS/eip-1193)
