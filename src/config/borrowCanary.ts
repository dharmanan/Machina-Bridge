// Product rollout only, not identity authentication. Every batch still needs independent binding/simulation and a user wallet confirmation.
// Public Borrow source gates remain closed. Only the separately guarded EOA transport can attest this canary path.
export const BORROW_CANARY = Object.freeze({ enabled: true, chainId: 5042, wallet: '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321' })
export function borrowCanaryAllows(owner: string | null | undefined): boolean {
  return BORROW_CANARY.enabled && typeof owner === 'string' && owner.toLowerCase() === BORROW_CANARY.wallet.toLowerCase()
}
