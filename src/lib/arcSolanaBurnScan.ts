// Classifies an Arc -> Solana burn found by the bounded recent scan. Read-only.
// A burn is offered for minting ONLY with full CCTP evidence:
//   the source burn is proven for this wallet and Phantom destination (readCctpBurnProof),
//   Circle's attestation for exactly that message is complete, and
//   the Solana UsedNonce for that message is unused at both confirmed and finalized.
// A used nonce proves the transfer is complete. Anything else is not mint-ready.
export type ArcSolanaBurnState =
  | { kind: 'mint_ready'; amount: string }
  | { kind: 'complete'; amount: string }
  | { kind: 'waiting_attestation' }
  | { kind: 'not_ours' }
  | { kind: 'unknown'; reason: string }

export type ArcSolanaBurnDeps = {
  proof(): Promise<{ amount: string; fields: { destinationDomain: number; destinationCaller: string } }>
  attestation(proof: unknown): Promise<{ status: 'pending' | 'complete'; message?: string; attestation?: string }>
  nonceUsed(message: string): Promise<boolean>
}

const ZERO_CALLER = '0x' + '00'.repeat(32)

export async function classifyArcSolanaBurn(phantomOwnerHex: string, deps: ArcSolanaBurnDeps): Promise<ArcSolanaBurnState> {
  let proof
  try {
    proof = await deps.proof()
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : 'The source burn could not be verified.' }
  }
  const caller = proof.fields.destinationCaller.toLowerCase()
  if (proof.fields.destinationDomain !== 5 || (caller !== ZERO_CALLER && caller !== phantomOwnerHex.toLowerCase())) return { kind: 'not_ours' }
  let attested
  try {
    attested = await deps.attestation(proof)
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : 'Circle attestation could not be read.' }
  }
  if (attested.status !== 'complete' || !attested.message || !attested.attestation) return { kind: 'waiting_attestation' }
  try {
    // Throws while confirmed and finalized disagree, or when the nonce account cannot be read.
    return (await deps.nonceUsed(attested.message)) ? { kind: 'complete', amount: proof.amount } : { kind: 'mint_ready', amount: proof.amount }
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : 'The Solana nonce could not be read.' }
  }
}

// One in-flight scan per wallet pair: a scan started for other wallets is never
// handed to the current ones.
export function keyedSingleFlight<T>() {
  let current: { key: string; promise: Promise<T> } | null = null
  return (key: string, run: () => Promise<T>): Promise<T> => {
    if (current && current.key === key) return current.promise
    const promise = run().finally(() => { if (current?.promise === promise) current = null })
    current = { key, promise }
    return promise
  }
}
