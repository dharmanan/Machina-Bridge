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
// Mainnet writes (user-approved 2026-10-29; product cap removed 2026-10-30).
// Every write still requires the live package/state/nonce/linkage proofs, an
// exact simulation, the CCTP protocol limits, sufficient balances, an explicit
// Review and Confirm, and the user's confirmation in the wallet.
export const MAINNET_SUI_CCTP_WRITES_ENABLED: boolean = true
// Separate gate for Arc eth_sendTransaction (wallet signs AND broadcasts;
// fields are verified only after broadcast).
export const MAINNET_ARC_WALLET_SEND_ENABLED: boolean = true
export const MAINNET_SUI_CCTP_BLOCKER = 'Mainnet transfer with real USDC. Nothing is sent until you review it and confirm each step in your wallet.'
