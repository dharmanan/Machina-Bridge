export const SOLANA_MAINNET_CCTP = {
  name: 'Solana',
  cctpDomain: 5,
  rpcUrl: import.meta.env.VITE_SOLANA_MAINNET_RPC?.trim() || 'https://api.mainnet-beta.solana.com',
  explorerUrl: 'https://solscan.io',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  tokenMessengerMinterProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
  fastTransferSource: true,
} as const
