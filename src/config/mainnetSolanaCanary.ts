export type MainnetSolanaCanaryDirection = 'arc-to-solana' | 'solana-to-arc'
export type MainnetSolanaCanaryPhase = 'candidate' | 'testing' | 'verified'

export const MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW = 100_000n

export const MAINNET_SOLANA_CCTP_CANARY_ROUTES: Record<
  MainnetSolanaCanaryDirection,
  MainnetSolanaCanaryPhase
> = {
  'arc-to-solana': 'verified',
  'solana-to-arc': 'testing',
}

export function isMainnetSolanaCanaryWriteEnabled(
  direction: MainnetSolanaCanaryDirection,
) {
  const phase = MAINNET_SOLANA_CCTP_CANARY_ROUTES[direction]
  return phase === 'testing' || phase === 'verified'
}
