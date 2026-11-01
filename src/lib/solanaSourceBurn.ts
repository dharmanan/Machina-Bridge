import { SOLANA_BRIDGE_PROGRAMS as P, SOLANA_USDC_MINT } from './solanaBridgeTxPolicy'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function decode58(value: string): Uint8Array {
  if (!value || value.length > 2048) throw new Error('Invalid instruction data')
  let n = 0n
  for (const c of value) { const d = B58.indexOf(c); if (d < 0) throw new Error('Invalid base58'); n = n * 58n + BigInt(d) }
  const bytes: number[] = []
  while (n) { bytes.push(Number(n & 255n)); n >>= 8n }
  for (const c of value) { if (c !== '1') break; bytes.push(0) }
  return Uint8Array.from(bytes.reverse())
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const uint = (b: Uint8Array, o: number, n: number) => {
  let v = 0n
  for (let i = o + n - 1; i >= o; i--) v = (v << 8n) | BigInt(b[i])
  return v
}
type Instruction = { programIdIndex: number; accounts: number[]; data: string }
type SourceTx = {
  transaction: { signatures: string[]; message: { header: { numRequiredSignatures: number }; accountKeys: string[]; instructions: Instruction[] } }
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] }; innerInstructions: Array<{ index: number; instructions: Instruction[] }>;
    preTokenBalances: Array<{ accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number } }> }
}

// Read-only chain classification, not a second pre-sign policy. Program presence and log
// strings alone are insufficient: incoming receives invoke TokenMessengerMinter too.
// Require a successful, wallet-signed CCTP deposit_for_burn to Arc AND its actual SPL USDC
// Burn in the same top-level invocation. Supports the existing Kit CPI and direct CCTP form.
export function isSolanaArcBurn(raw: unknown, owner: string, signature: string): boolean {
  try {
    const tx = raw as SourceTx
    if (!tx.meta || tx.meta.err !== null || tx.transaction.signatures[0] !== signature) return false
    const msg = tx.transaction.message
    const signers = msg.header.numRequiredSignatures
    if (!Number.isSafeInteger(signers) || signers < 1 || !msg.accountKeys.slice(0, signers).includes(owner)) return false
    const keys = [...msg.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])]
    let found = 0
    for (let index = 0; index < msg.instructions.length; index++) {
      const top = msg.instructions[index]
      const inner = tx.meta.innerInstructions.filter(g => g.index === index).flatMap(g => g.instructions)
      const deposits = [top, ...inner].filter(ix => keys[ix.programIdIndex] === P.tokenMessengerMinter && hex(decode58(ix.data).subarray(0, 8)) === 'd73c3d2e723780b0')
      for (const ix of deposits) {
        const d = decode58(ix.data)
        // CCTP V2 deposit_for_burn: amount(u64), destination(u32), recipient(bytes32),
        // caller(bytes32), maxFee(u64), minFinality(u32). No hooks/unknown variants.
        if (d.length !== 96 || ix.accounts.length !== 18 || uint(d, 16, 4) !== 26n || keys[ix.accounts[0]] !== owner) return false
        const amount = uint(d, 8, 8), accountIndex = ix.accounts[3], mintIndex = ix.accounts[10]
        if (amount <= 0n || keys[mintIndex] !== SOLANA_USDC_MINT || hex(d.subarray(20, 32)) !== '0'.repeat(24) || uint(d, 32, 20) === 0n) return false
        const balance = tx.meta.preTokenBalances.find(b => b.accountIndex === accountIndex)
        if (!balance || balance.owner !== owner || balance.mint !== SOLANA_USDC_MINT || balance.uiTokenAmount.decimals !== 6 || BigInt(balance.uiTokenAmount.amount) < amount) return false
        const burns = inner.filter(b => {
          if (keys[b.programIdIndex] !== P.token || b.accounts[0] !== accountIndex || b.accounts[1] !== mintIndex || keys[b.accounts[2]] !== owner) return false
          const data = decode58(b.data)
          return data.length === 9 && data[0] === 8 && uint(data, 1, 8) === amount
        })
        if (burns.length !== 1) return false
        found++
      }
    }
    return found === 1 // multiple source burns are ambiguous, never choose one
  } catch { return false }
}
