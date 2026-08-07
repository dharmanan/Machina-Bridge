import type { Address } from 'viem'

// Final Arc Testnet countdown contract (V3), verified onchain and in ArcScan.
// Pinned in source so Preview and Production cannot diverge via environment configuration.
export const COUNTDOWN_CONTRACT_ADDRESS = '0xe2AF77Ea3Af88dB62CbF3eb0509b91751437892A' as Address
export const HAS_COUNTDOWN_CONTRACT = true

export const COUNTDOWN_ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'currentDay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'claimedBitmap', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'claimedCount', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'hasClaimed', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }, { name: 'day', type: 'uint8' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'eligibilityTier', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'setTestDay', stateMutability: 'nonpayable', inputs: [{ name: 'day', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'resetSmokeDay', stateMutability: 'nonpayable', inputs: [{ name: 'wallet', type: 'address' }, { name: 'day', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'setMetadataUri', stateMutability: 'nonpayable', inputs: [{ name: 'newUri', type: 'string' }], outputs: [] },
  { type: 'function', name: 'uri', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'event', name: 'DailyClaim', anonymous: false, inputs: [{ indexed: true, name: 'wallet', type: 'address' }, { indexed: true, name: 'day', type: 'uint8' }, { indexed: true, name: 'tokenId', type: 'uint256' }] },
] as const

export function bitmapToDays(bitmap: bigint) {
  const days: number[] = []
  for (let day = 1; day <= 40; day += 1) {
    if ((bitmap & (1n << BigInt(day - 1))) !== 0n) days.push(day)
  }
  return days
}
