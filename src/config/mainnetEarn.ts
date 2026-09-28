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

// Verified Circle Guarded identity for the launch preview. The vault name,
// APY, liquidity, fees, and status still come from live discovery data.
export const MAINNET_EARN_VERIFIED_GUARDED_VAULT_ADDRESSES = [
  '0x8E357432CC12ff425c36432F312968aEb16112AF',
  '0xdECcd53BE5453215821184824B519E04C7e00bC7',
] as const
