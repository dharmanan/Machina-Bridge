export const MAINNET_EARN_READ_ONLY_ENABLED = true

// Galaxy and Gauntlet completed Arc mainnet deposit and withdraw canaries
// before wallet initiated Earn actions were enabled.
export const MAINNET_EARN_WRITES_ENABLED = true

export const MAINNET_EARN_CHAIN = 'Arc' as const
export const MAINNET_EARN_ASSET = 'USDC' as const

export const MAINNET_EARN_SELECTED_VAULT_ADDRESSES = [
  '0x8E357432CC12ff425c36432F312968aEb16112AF',
  '0xdECcd53BE5453215821184824B519E04C7e00bC7',
] as const

export type MainnetEarnVaultMetadata = {
  address: `0x${string}`
  label: string
  shareSymbol?: string
  shareDecimals?: number
}

// Wallet Activity only formats approval limits for vault shares listed here.
// Add verified share metadata by address to extend Earn activity labeling.
export const MAINNET_EARN_VAULT_METADATA: readonly MainnetEarnVaultMetadata[] = [
  {
    address: '0x8E357432CC12ff425c36432F312968aEb16112AF',
    label: 'Galaxy USDC',
    shareSymbol: 'arcUSDC',
    shareDecimals: 18,
  },
  {
    address: '0xdECcd53BE5453215821184824B519E04C7e00bC7',
    label: 'Gauntlet USDC Prime',
    shareSymbol: 'gtusdcp',
    shareDecimals: 18,
  },
]

// Verified Circle Guarded identity for the launch preview. The vault name,
// APY, liquidity, fees, and status still come from live discovery data.
export const MAINNET_EARN_VERIFIED_GUARDED_VAULT_ADDRESSES = [
  '0x8E357432CC12ff425c36432F312968aEb16112AF',
  '0xdECcd53BE5453215821184824B519E04C7e00bC7',
] as const
