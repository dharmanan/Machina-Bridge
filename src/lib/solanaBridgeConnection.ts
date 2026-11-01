// The installed Solana adapter signs, broadcasts, then uses web3.js confirmTransaction,
// which requires signatureSubscribe over WebSocket. Our POST-only /api/solana-rpc
// cannot serve that subscription. Use the same existing endpoint as receive recovery;
// the evidence readers deliberately continue to use the HTTP proxy independently.
export const SOLANA_BRIDGE_SDK_RPC = 'https://solana-rpc.publicnode.com'

export type SolanaSourceStage = 'preparing' | 'preparation-failed' | 'policy-blocked' | 'wallet-requested'
  | 'wallet-rejected' | 'wallet-unknown' | 'wallet-signed' | 'repeat-blocked'

// Fixed descriptions only: never include provider errors, addresses, payloads or RPC URLs.
// After signing, the SDK's generic network error cannot distinguish broadcast from confirmation.
export function solanaSourceFailure(stage: SolanaSourceStage): string {
  switch (stage) {
    case 'policy-blocked': return 'Machina G2 rejected the Solana transaction before the wallet request. Nothing was signed or sent by this attempt.'
    case 'wallet-rejected': return 'The Solana burn request was rejected in the wallet. No automatic retry was made.'
    case 'wallet-requested':
    case 'wallet-unknown': return 'The Solana wallet request has an unknown outcome. Do not sign again; check Activity. No automatic second burn was requested.'
    case 'wallet-signed': return 'Phantom returned a signed Solana burn, but its broadcast or confirmation could not be verified. Check Activity to recover an existing burn; do not send again.'
    case 'repeat-blocked': return 'B1 blocked a second Solana burn signature request. The first request must be checked in Activity before any new transfer.'
    default: return 'Solana transaction preparation or network reading failed before the burn wallet request. No automatic retry was made.'
  }
}
