// Borrow reads use the keyless Circle Borrow Service through
// @circle-fin/borrow-kit. They never sign and never touch a wallet.
export const MAINNET_BORROW_READ_ONLY_ENABLED: boolean = true

// Borrow writes stay off until the Borrow UI, wallet capability checks and a
// mainnet canary are reviewed. This is a source constant on purpose: no
// environment variable, URL parameter or browser storage value can enable it.
export const MAINNET_BORROW_WRITES_ENABLED: boolean = false

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
// Utilization at or above this ratio is flagged: little liquidity is left to borrow and the rate can move quickly.
export const MAINNET_BORROW_HIGH_UTILIZATION = 0.9
