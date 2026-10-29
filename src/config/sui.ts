// Network/USDC identifiers: Circle's installed official chain catalogue,
// @circle-fin/provider-cctp-v2 (Sui / Sui_Testnet). These are NOT V2 package IDs.
export type SuiNetwork = 'mainnet' | 'testnet'
export const SUI_NETWORKS = {
  mainnet: {
    url: 'https://fullnode.mainnet.sui.io:443',
    network: 'mainnet',
    // MystenLabs/sui@eabaa1cc, crates/sui-types/src/digests.rs.
    chainIdentifier: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
    usdcCoinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  },
  testnet: {
    url: 'https://fullnode.testnet.sui.io:443',
    network: 'testnet',
    chainIdentifier: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
    usdcCoinType: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
  },
} as const

export const SUI_CCTP_DOMAIN = 8
export const ARC_CCTP_DOMAIN = 26
// Controlled live test (user-approved 2026-10-29). Writes still require the
// live package/state/nonce/linkage proofs, an explicit Review and Confirm, and
// stay capped by MAINNET_SUI_CCTP_TEST_MAX_UNITS.
export const MAINNET_SUI_CCTP_WRITES_ENABLED: boolean = true
// Separate gate for Arc eth_sendTransaction (wallet signs AND broadcasts;
// fields are verified only after broadcast). Enabled for the same test phase.
export const MAINNET_ARC_WALLET_SEND_ENABLED: boolean = true
// First live test phase: at most 0.1 USDC (6 decimals) per transaction, every
// action including mints. Raising it needs separate user approval; it is never
// raised automatically for fees or protocol minimums.
export const MAINNET_SUI_CCTP_TEST_MAX_UNITS = 100_000n
export const MAINNET_SUI_CCTP_BLOCKER = 'Live test: at most 0.1 USDC per transfer. Every wallet step needs your Review and your confirmation in the wallet.'
