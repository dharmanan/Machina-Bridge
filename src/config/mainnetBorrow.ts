// Borrow reads use the keyless Circle Borrow Service through
// @circle-fin/borrow-kit. They never sign and never touch a wallet.
export const MAINNET_BORROW_READ_ONLY_ENABLED: boolean = true

// Borrow writes stay off until the Borrow UI, wallet capability checks and a
// mainnet canary are reviewed. This is a source constant on purpose: no
// environment variable, URL parameter or browser storage value can enable it.
export const MAINNET_BORROW_WRITES_ENABLED: boolean = false
// Separate from product rollout: the current EIP-5792 adapter cannot enforce the reviewed maximum wallet gas cost.
// No environment variable or UI test option may assert that the production transport is economically bound.
export const MAINNET_BORROW_EXECUTION_BOUND: boolean = false

// BorrowChain.Arc in @circle-fin/borrow-kit@1.0.0 (API chain "ARC").
export const MAINNET_BORROW_CHAIN = 'Arc' as const
export const MAINNET_BORROW_CHAIN_ID = 5042

// Circle Borrow Adapter on Arc mainnet, from the SDK's Arc chain definition
// (kitContracts.adapter). Borrow Kit grants exact ERC-20 allowances and the
// temporary Morpho authorization to this contract only.
export const MAINNET_BORROW_ADAPTER_CONTRACT = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845' as const

// Borrow Kit submits every write as one atomic batch. With the installed
// @circle-fin/adapter-viem-v2 (1.18.x) that requires an EIP-5792 wallet that
// reports atomic batch support on Arc. Plain EOA batching on Arc arrives with
// the adapter's /next entry point in 1.19.0 and is not enabled here.
export const MAINNET_BORROW_REQUIRED_WALLET_CAPABILITY = 'eip5792-atomic-batch' as const

// Slippage bound Machina would pass for service-sized legs (SDK default).
export const MAINNET_BORROW_DEFAULT_SLIPPAGE_BPS = 300

// Morpho Blue singleton on Arc mainnet (official Morpho address list, Arc rows; the same address the compact engine reads
// in server/compact/protocols/morpho.js). Borrow markets are verified against its on-chain market parameters.
export const MAINNET_BORROW_MORPHO_BLUE = '0x34cd04070dd72b14e241112f6d83812df5af7fcd' as const

// Fixed, read-only risk labels for the Borrow preview. They are thresholds, not data: no APY, liquidity amount or price is
// hardcoded, and nothing here ranks or recommends a market.
// MAX_LTV is the starting cap a future borrow would be checked against. Staying below it does not protect against liquidation.
export const MAINNET_BORROW_MAX_LTV = 0.7
// Utilization at or above this ratio is flagged as a market-wide rate risk: most supplied funds are lent out and the variable rate can
// move quickly. It says nothing about the absolute amount available.
export const MAINNET_BORROW_HIGH_UTILIZATION = 0.9

// Transaction safety limits (Stage 2). Fixed labels like the two above: the checks that use them run in planBorrowWrite and are
// re-run inside executeBorrowWrite, so a caller cannot skip them by skipping the UI.
// A quote, position, market read, on-chain check or wallet balance older than this is not used to prepare a transaction. The
// Borrow Service gives no quote expiry of its own, so this is Machina's own bound.
export const MAINNET_BORROW_MAX_EVIDENCE_AGE_MS = 60_000
// Highest slippage bound Machina would pass for Repay-side legs: Withdraw collateral and Close loan, where it only sets how much
// repayment headroom the wallet must cover. The SDK default (300) sits below it.
export const MAINNET_BORROW_MAX_SLIPPAGE_BPS = 500
// For Borrow and Borrow more the service adds this setting to the collateral it sizes (a "drift buffer": at 0 it sizes the exact base
// collateral, at 300 it adds 3%), so it is how a quote reaches a higher Health Factor. It can only add collateral, never reduce it, and
// the Health Factor, LTV and wallet balance checks still apply to the quote it produces. 10 000 is the SDK's own maximum.
export const MAINNET_BORROW_MAX_COLLATERAL_BUFFER_BPS = 10_000
// Arc's native gas currency is USDC with 18 decimals (see MAINNET_ARC_NATIVE_CURRENCY). Its ERC-20 interface is this
// token. A wallet that pays gas and a loan in USDC is checked for both together.
export const MAINNET_BORROW_NATIVE_DECIMALS = 18
export const MAINNET_BORROW_NATIVE_BACKED_TOKEN = '0x3600000000000000000000000000000000000000' as const
