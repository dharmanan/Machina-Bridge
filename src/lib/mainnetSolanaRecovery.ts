import { PublicKey } from '@solana/web3.js'
import { sha256, stringToHex } from 'viem'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { decodeCctpRecoveryMessage } from './mainnetCctpRecovery'
export async function readSolanaCctpMessageUsed(message: string, read: (method: 'getAccountInfo', params: unknown[]) => Promise<any>): Promise<boolean> {
  const fields = decodeCctpRecoveryMessage(message)
  if (fields.destinationDomain !== 5 || /^0x0{64}$/.test(fields.nonce)) throw new Error('Invalid Solana destination message or nonce.')
  const nonce = Uint8Array.from(fields.nonce.slice(2).match(/../g)!, b=>parseInt(b,16)), program = new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram)
  const [pda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('used_nonce'),nonce],program)
  const result = await read('getAccountInfo',[pda.toBase58(),{encoding:'base64',commitment:'finalized'}])
  if (!result || !Object.prototype.hasOwnProperty.call(result,'value')) throw new Error('Solana nonce state is unavailable; no mint is allowed.')
  if (result.value === null) return false
  const account = result.value
  if (account.owner !== program.toBase58() || !Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error('Solana nonce account has an unexpected owner or encoding.')
  const bytes = Uint8Array.from(atob(account.data[0]), c=>c.charCodeAt(0)), expected = sha256(stringToHex('account:UsedNonce')).slice(2,18)
  if (bytes.length !== 9 || Array.from(bytes.slice(0,8),b=>b.toString(16).padStart(2,'0')).join('') !== expected || ![0,1].includes(bytes[8])) throw new Error('Solana nonce account integrity is unverified.')
  return bytes[8] === 1
}
