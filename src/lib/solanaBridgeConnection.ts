import { Connection, VersionedTransaction } from '@solana/web3.js'

// Adapter 1.7.3 probes WebSocket support by converting connection.rpcEndpoint,
// independently of web3.js's wsEndpoint. Keep both endpoint identities on the
// existing RPC provider, and route HTTP through the same-origin proxy via the
// supported fetch transport. Neither probe nor confirmation may use the HTTP API.
export const SOLANA_BRIDGE_SDK_RPC = 'https://solana-rpc.publicnode.com'

export function createSolanaBridgeConnection(origin: string): Connection {
  const proxy = new URL('/api/solana-rpc', origin).href
  const connection = new Connection(SOLANA_BRIDGE_SDK_RPC, {
    commitment: 'confirmed',
    wsEndpoint: SOLANA_BRIDGE_SDK_RPC.replace(/^https:/, 'wss:'),
    fetch: (_input, init) => fetch(proxy, init),
  })
  const send = connection.sendRawTransaction.bind(connection)
  connection.sendRawTransaction = async (bytes, options) => {
    // The wallet may have taken longer than the recent blockhash's lifetime.
    // Never rewrite signed bytes or ask for another signature automatically.
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes))
    const valid = await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })
    if (!valid.value) throw new Error('The signed Solana transaction expired before broadcast. Check Activity before preparing another request.')
    return send(bytes, options)
  }
  return connection
}

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
