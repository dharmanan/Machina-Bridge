const configuredMainnetRpc = import.meta.env.VITE_SOLANA_MAINNET_RPC?.trim()

export const SOLANA_MAINNET_CCTP = {
  name: 'Solana',
  cctpDomain: 5,
  rpcUrl: configuredMainnetRpc || 'https://api.mainnet-beta.solana.com',
  rpcUrls: [
    ...(configuredMainnetRpc ? [configuredMainnetRpc] : []),
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
  ],
  explorerUrl: 'https://solscan.io',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  tokenMessengerMinterProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
  fastTransferSource: true,
} as const
