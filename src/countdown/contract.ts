import type { Address } from 'viem'

const envAddress = import.meta.env.VITE_COUNTDOWN_CONTRACT_ADDRESS?.trim() || ''
const storedPreviewAddress = typeof window !== 'undefined'
  ? window.localStorage.getItem('machina-countdown-contract-address') || ''
  : ''

export const COUNTDOWN_CONTRACT_ADDRESS = (envAddress || storedPreviewAddress) as Address
export const HAS_COUNTDOWN_CONTRACT = /^0x[a-fA-F0-9]{40}$/.test(COUNTDOWN_CONTRACT_ADDRESS)

export const COUNTDOWN_ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'currentDay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'claimedBitmap', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'claimedCount', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'hasClaimed', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }, { name: 'day', type: 'uint8' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'eligibilityTier', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'setTestDay', stateMutability: 'nonpayable', inputs: [{ name: 'day', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'resetSmokeDay', stateMutability: 'nonpayable', inputs: [{ name: 'wallet', type: 'address' }, { name: 'day', type: 'uint8' }], outputs: [] },
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
