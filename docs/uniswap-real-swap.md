# Uniswap Arc execution candidate — disabled pending independent review

This implements native USDC -> EURC (CLASSIC V4) and native USDC -> cirBTC
(CLASSIC V3) for Arc Mainnet 5042. Circle remains preview-only. No reverse route,
approval, Permit2 signature, arbitrary token/router or additional provider exists.

The initial pilot additionally restricts execution to one configured wallet and
USDC → EURC at most 0.1 USDC. cirBTC remains preview-only in the application.
Both the existing source release gate and the new default-off pilot configuration
must permit execution. See [pilot opening/closing procedure](uniswap-pilot.md).

## Release boundary

`UNISWAP_ARC_WRITES_ENABLED` in `src/lib/uniswapArcPolicy.ts` remains **false**.
Both execution preparation and confirmation enforce it. There is no environment,
URL, localStorage or DOM switch that enables the production application. A future
reviewed release must explicitly change this source gate after owner approval.
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
   prices, exact calldata simulation, gas estimate and pending nonce. Contract and
   EIP-7702 delegated wallets fail closed; their execution semantics are unsupported.
4. The review dialog shows pay/estimated/minimum output, slippage, network and total
   spend ceiling, recipient/router and validity. Cancel or a changed wallet,
   connector, network, amount, provider, slippage or hidden page invalidates it.
5. **Confirm Swap** refers only to an opaque ID for a private in-memory intent.
   Rendered objects and stored reviews cannot supply a transaction to this method.
   The same intent is resimulated and rechecked; changed nonce/fees or expiry require
   a new review. No silent re-quote or economic mutation occurs after confirmation.
6. A per-wallet Web Lock is acquired, unresolved attempts are checked, wallet
   `eth_chainId`/`eth_accounts`/pending nonce are independently checked, and a durable
   intent is written and read back **before** the wallet request. There must be at
   least five seconds of verified validity left immediately before that request.
7. Exactly one `eth_sendTransaction` contains the verified native value, calldata,
   sender, router, chain, nonce, gas and EIP-1559 fee caps. No signing-message,
   typed-data, raw-send, batched-call, approval or account-request action is used by
   the execution path. The existing connected wagmi connector supplies the provider.

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
Original evidence bytes and the production source gate are unchanged.

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
