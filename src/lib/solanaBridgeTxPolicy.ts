// Independent check of every Solana transaction Circle Bridge Kit hands to Phantom (F1 / G2).
//
// Bridge Kit's Solana adapter loads its programs with Anchor `Program.at`, which reads the IDL
// from the RPC and takes the program id from `idl.address`. A manipulated RPC answer could
// therefore point the instruction at another program while the user is a signer. This module
// does not trust the SDK, the IDL or the RPC: the allowed programs, discriminators, account
// positions and expected values are fixed here or come from Machina's own verified transfer
// context (connected wallets, reviewed amount, Circle-attested message). Anything else is refused
// BEFORE the wallet is asked to sign.
//
// Shapes are taken from real mainnet transactions (burn QsF23bfa…, receive 5SsG9DW7…) and the
// on-chain IDLs of the three programs. Branches not seen on chain yet (ATA creation, the
// separate ATA-only fallback transaction) are allowed only in the narrow form the installed
// adapter builds.
import { PublicKey } from '@solana/web3.js'
import { decodeCctpRecoveryMessage } from './mainnetCctpRecovery'

export const SOLANA_BRIDGE_PROGRAMS = Object.freeze({
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  kitBridge: 'DFaauJEjmiHkPs1JG89A4p95hDWi9m9SAEERY1LQJiC3',
  tokenMessengerMinter: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
  messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
})
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SOLANA_CCTP_ALT = 'qj4EYgsGpnRdt9rvQW3wWZR8JVaKPg9rG9EB8DNgfz8'
// Bridge Kit funds the burn's MessageSent event account with exactly this amount (adapter constant).
export const KIT_EVENT_ACCOUNT_LAMPORTS = 3_900_000n
// Ceilings for values the SDK chooses. A higher value is refused (fails safe).
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n
export const MAX_PRIORITY_FEE_LAMPORTS = 2_000_000n // 0.002 SOL
const DISC_BRIDGE = 'ae29789262daa919' // sha256("global:bridge")[0..8]
const DISC_RECEIVE = '26907fe11fe1ee19' // sha256("global:receive_message")[0..8]
// Kit `bridge` account order (on-chain IDL bridging_kit 0.1.0).
const BRIDGE = { accounts: 23, authority: 1, eventRentPayer: 2, burnTokenAccount: 4, burnTokenMint: 12, messageSentEventData: 13,
  messageTransmitterProgram: 14, tokenMessengerMinterProgram: 15, tokenProgram: 16, systemProgram: 17, cctpProgram: 18,
  protocolFeeAta: 19, developerFeeAta: 20, program: 22 } as const

export type SolanaBurnExpectation = {
  kind: 'burn'
  owner: string // connected Phantom wallet
  amountRaw: bigint // reviewed amount in USDC base units
  evmRecipient: string // connected Arc wallet (0x…)
  maxFeeRaw?: bigint // ceiling for the CCTP max fee; default 1% of the amount
}
export type SolanaReceiveExpectation = {
  kind: 'receive'
  owner: string // connected Phantom wallet (payer and USDC recipient)
  amountRaw?: bigint // burn amount, when known
  exactMessage?: string // recovery: the Circle-attested message verified against the Arc burn
}
export type SolanaTxExpectation = SolanaBurnExpectation | SolanaReceiveExpectation

export class SolanaTxPolicyError extends Error {
  constructor(public code: string, detail: string) {
    super(`Machina stopped this Solana transaction before your wallet saw it (${code}): ${detail} Nothing was signed or sent.`)
    this.name = 'SolanaTxPolicyError'
  }
}
const deny = (code: string, detail: string): never => { throw new SolanaTxPolicyError(code, detail) }

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const word = (key: string) => '0x' + hex(new PublicKey(key).toBytes())
const evmWord = (address: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) deny('expectation', 'The Arc recipient is not a valid address.')
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0')
}
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24
const u64 = (b: Uint8Array, o: number) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v }
export function solanaAta(owner: string, mint = SOLANA_USDC_MINT) {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBytes(), new PublicKey(SOLANA_BRIDGE_PROGRAMS.token).toBytes(), new PublicKey(mint).toBytes()],
    new PublicKey(SOLANA_BRIDGE_PROGRAMS.associatedToken))[0].toBase58()
}

type Compiled = { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }
type View = { keys: string[]; numSigners: number; readonlySigned: number; lookups: { accountKey: string }[]; ixs: Compiled[] }

// Reads a VersionedTransaction (v0 or legacy message). Anything else (e.g. a legacy Transaction) is refused.
function view(tx: unknown): View {
  const m = (tx as { message?: any })?.message
  if (!m || !Array.isArray(m.staticAccountKeys) || !Array.isArray(m.compiledInstructions) || !m.header) deny('format', 'Only versioned Solana transactions are accepted.')
  const keys: string[] = m.staticAccountKeys.map((k: any) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)))
  return {
    keys,
    numSigners: m.header.numRequiredSignatures,
    readonlySigned: m.header.numReadonlySignedAccounts,
    lookups: (m.addressTableLookups ?? []).map((l: any) => ({ accountKey: typeof l.accountKey?.toBase58 === 'function' ? l.accountKey.toBase58() : String(l.accountKey) })),
    ixs: m.compiledInstructions.map((i: any) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: Array.from(i.accountKeyIndexes ?? []), data: Uint8Array.from(i.data ?? []) })),
  }
}
// Program ids must be static keys: an instruction cannot invoke a program loaded from a lookup table.
const programOf = (v: View, ix: Compiled) => v.keys[ix.programIdIndex] ?? deny('program', 'An instruction names a program outside the static account list.')
// Resolves an instruction account that must be a static key (signers, the fee payer, user accounts).
const staticAccount = (v: View, ix: Compiled, i: number, what: string) => {
  const index = ix.accountKeyIndexes[i]
  if (index === undefined || index >= v.keys.length) deny('accounts', `${what} is missing or not in the static account list.`)
  return v.keys[index]
}

function checkComputeBudget(ixs: Compiled[]) {
  let limit: bigint | undefined, price: bigint | undefined
  for (const ix of ixs) {
    const d = ix.data
    if (d[0] === 2 && d.length === 5 && limit === undefined) limit = BigInt(u32(d, 1))
    else if (d[0] === 3 && d.length === 9 && price === undefined) price = u64(d, 1)
    else deny('compute_budget', 'Only one compute unit limit and one compute unit price are allowed.')
  }
  const units = limit ?? MAX_COMPUTE_UNIT_LIMIT // no explicit limit: assume the worst case
  if (units > MAX_COMPUTE_UNIT_LIMIT) deny('compute_budget', 'The compute unit limit is above the allowed ceiling.')
  if (((price ?? 0n) * units + 999_999n) / 1_000_000n > MAX_PRIORITY_FEE_LAMPORTS) deny('compute_budget', 'The priority fee is above the allowed ceiling (0.002 SOL).')
}

// ATA creation (Create, or CreateIdempotent) of `owner`'s USDC account, paid by the connected wallet.
function checkAta(v: View, ix: Compiled, payer: string, allowedOwner: (owner: string, ata: string) => boolean) {
  if (ix.data.length > 1 || (ix.data.length === 1 && ix.data[0] !== 0 && ix.data[0] !== 1)) deny('ata', 'Only associated token account creation is allowed.')
  if (ix.accountKeyIndexes.length !== 6) deny('ata', 'Unexpected associated token account instruction.')
  if (staticAccount(v, ix, 0, 'The ATA payer') !== payer) deny('ata', 'The ATA rent must be paid by the connected wallet.')
  const ata = staticAccount(v, ix, 1, 'The new ATA'), owner = staticAccount(v, ix, 2, 'The ATA owner')
  // The derived address binds the mint: an ATA of another mint has another address and fails on chain.
  if (ata !== solanaAta(owner)) deny('ata', 'The ATA is not the USDC account of its owner.')
  if (!allowedOwner(owner, ata)) deny('ata', 'This ATA is not part of the expected transfer.')
}

function signerRules(v: View, owner: string, count: number) {
  if (v.keys[0] !== owner) deny('fee_payer', 'The fee payer is not the connected Phantom wallet.')
  if (v.numSigners !== count || v.readonlySigned !== 0) deny('signers', 'The transaction asks for an unexpected set of signers.')
}

function checkBurn(v: View, e: SolanaBurnExpectation) {
  const P = SOLANA_BRIDGE_PROGRAMS
  signerRules(v, e.owner, 2)
  const eventAccount = v.keys[1]
  if (eventAccount === e.owner) deny('signers', 'The second signer must be the new event account.')
  if (v.lookups.length) deny('lookup_table', 'A burn transaction must not use address lookup tables.')
  if (e.amountRaw <= 0n) deny('expectation', 'The reviewed amount is invalid.')
  const cb: Compiled[] = [], ata: Compiled[] = [], transfers: Compiled[] = [], bridges: Compiled[] = []
  for (const ix of v.ixs) {
    const p = programOf(v, ix)
    if (p === P.computeBudget) cb.push(ix)
    else if (p === P.associatedToken) ata.push(ix)
    else if (p === P.system) transfers.push(ix)
    else if (p === P.kitBridge) bridges.push(ix)
    else deny('program', `Program ${p} is not allowed in a Solana → Arc burn.`)
  }
  if (bridges.length !== 1 || v.ixs[v.ixs.length - 1] !== bridges[0]) deny('program', 'Exactly one Bridge Kit burn must be the last instruction.')
  if (transfers.length !== 1) deny('system', 'Exactly one SOL transfer (the event account rent) is allowed.')
  if (ata.length > 2) deny('ata', 'Too many associated token account instructions.')
  checkComputeBudget(cb)

  const b = bridges[0], d = b.data
  if (hex(d.subarray(0, 8)) !== DISC_BRIDGE || d.length !== 104) deny('instruction', 'The Bridge Kit instruction is not `bridge`.')
  const amount = u64(d, 8), domain = u32(d, 16), mintRecipient = '0x' + hex(d.subarray(20, 52)), caller = hex(d.subarray(52, 84))
  const maxFee = u64(d, 84), finality = u32(d, 92), kitFee = u64(d, 96)
  if (amount !== e.amountRaw) deny('amount', 'The burn amount differs from the reviewed amount.')
  if (domain !== 26) deny('destination', 'The burn is not for Arc (CCTP domain 26).')
  if (mintRecipient !== evmWord(e.evmRecipient)) deny('recipient', 'The burn does not mint to the connected Arc wallet.')
  if (/[^0]/.test(caller)) deny('destination_caller', 'The burn restricts who may receive it on Arc.')
  if (kitFee !== 0n) deny('fee', 'The burn carries a Bridge Kit fee.')
  if (maxFee > (e.maxFeeRaw ?? e.amountRaw / 100n)) deny('fee', 'The CCTP max fee is above the allowed ceiling.')
  if (finality !== 1000 && finality !== 2000) deny('finality', 'Unexpected finality threshold.')

  if (b.accountKeyIndexes.length !== BRIDGE.accounts) deny('accounts', 'Unexpected Bridge Kit account list.')
  const acc = (i: number, what: string) => staticAccount(v, b, i, what)
  const must: [number, string, string][] = [
    [BRIDGE.authority, e.owner, 'The burn authority'], [BRIDGE.eventRentPayer, e.owner, 'The event rent payer'],
    [BRIDGE.burnTokenAccount, solanaAta(e.owner), 'The burned token account'], [BRIDGE.burnTokenMint, SOLANA_USDC_MINT, 'The burned mint'],
    [BRIDGE.messageSentEventData, eventAccount, 'The event account'], [BRIDGE.messageTransmitterProgram, P.messageTransmitter, 'The message transmitter'],
    [BRIDGE.tokenMessengerMinterProgram, P.tokenMessengerMinter, 'The token messenger'], [BRIDGE.tokenProgram, P.token, 'The token program'],
    [BRIDGE.systemProgram, P.system, 'The system program'], [BRIDGE.cctpProgram, P.tokenMessengerMinter, 'The CCTP program'], [BRIDGE.program, P.kitBridge, 'The Bridge Kit program'],
  ]
  for (const [i, expected, what] of must) if (acc(i, what) !== expected) deny('accounts', `${what} is not the expected account.`)
  const feeAtas = [acc(BRIDGE.protocolFeeAta, 'The protocol fee account'), acc(BRIDGE.developerFeeAta, 'The developer fee account')]

  const t = transfers[0]
  if (t.data.length !== 12 || u32(t.data, 0) !== 2) deny('system', 'Only a plain SOL transfer is allowed.')
  if (staticAccount(v, t, 0, 'The SOL sender') !== e.owner || staticAccount(v, t, 1, 'The SOL recipient') !== eventAccount) deny('system', 'The SOL transfer must fund the new event account from the connected wallet.')
  if (u64(t.data, 4) !== KIT_EVENT_ACCOUNT_LAMPORTS) deny('system', 'The SOL transfer differs from the event account rent.')
  // Fee ATAs are created only when missing; they must be the fee accounts named by the burn, never the user's.
  for (const ix of ata) checkAta(v, ix, e.owner, (owner, address) => owner !== e.owner && feeAtas.includes(address))
}

function checkReceive(v: View, e: SolanaReceiveExpectation) {
  const P = SOLANA_BRIDGE_PROGRAMS
  signerRules(v, e.owner, 1)
  if (v.lookups.some(l => l.accountKey !== SOLANA_CCTP_ALT) || v.lookups.length > 1) deny('lookup_table', 'Only the CCTP address lookup table is allowed.')
  const cb: Compiled[] = [], ata: Compiled[] = [], receives: Compiled[] = []
  for (const ix of v.ixs) {
    const p = programOf(v, ix)
    if (p === P.computeBudget) cb.push(ix)
    else if (p === P.associatedToken) ata.push(ix)
    else if (p === P.messageTransmitter) receives.push(ix)
    else deny('program', `Program ${p} is not allowed in a Solana receive.`)
  }
  checkComputeBudget(cb)
  // The adapter creates the user's USDC account in the same transaction, or alone first when the
  // combined transaction would be too large; both forms are accepted.
  if (ata.length > 1 || receives.length > 1 || (receives.length === 0 && ata.length === 0)) deny('program', 'Expected one USDC receive, or the creation of your USDC account.')
  for (const ix of ata) checkAta(v, ix, e.owner, owner => owner === e.owner)
  if (!receives.length) return
  const r = receives[0], d = r.data
  if (hex(d.subarray(0, 8)) !== DISC_RECEIVE || d.length < 16) deny('instruction', 'The message transmitter instruction is not `receive_message`.')
  if (staticAccount(v, r, 0, 'The receive payer') !== e.owner || staticAccount(v, r, 1, 'The receive caller') !== e.owner) deny('accounts', 'The receive must be paid and called by the connected wallet.')
  const len = u32(d, 8)
  if (len !== 376 || d.length < 12 + len + 4) deny('message', 'Unexpected CCTP message length.')
  const message = '0x' + hex(d.subarray(12, 12 + len))
  if (u32(d, 12 + len) !== 130 || d.length !== 12 + len + 4 + 130) deny('message', 'Unexpected attestation length.')
  let m: ReturnType<typeof decodeCctpRecoveryMessage>
  try { m = decodeCctpRecoveryMessage(message) } catch { return deny('message', 'The CCTP message could not be decoded.') }
  if (m.sourceDomain !== 26 || m.destinationDomain !== 5) deny('destination', 'The message is not an Arc → Solana transfer.')
  if (![word(solanaAta(e.owner)), word(e.owner)].includes(m.mintRecipient)) deny('recipient', 'The message does not pay the connected Phantom wallet.')
  if (!['0x' + '0'.repeat(64), word(e.owner)].includes(m.destinationCaller)) deny('destination_caller', 'The message names another receiver.')
  if (e.amountRaw !== undefined && m.amount !== e.amountRaw) deny('amount', 'The message amount differs from the transfer amount.')
  if (e.exactMessage !== undefined && message !== e.exactMessage.toLowerCase()) deny('message', 'The message differs from the Circle-attested message.')
}

export function assertSolanaBridgeTransaction(tx: unknown, expected: SolanaTxExpectation) {
  try { new PublicKey(expected.owner) } catch { deny('expectation', 'The connected Phantom wallet is invalid.') }
  const v = view(tx)
  if (expected.kind === 'burn') checkBurn(v, expected)
  else if (expected.kind === 'receive') checkReceive(v, expected)
  else deny('expectation', 'Unknown transaction kind.')
}

// The Phantom provider handed to Bridge Kit: every transaction is checked before Phantom sees it.
// Only `signTransaction` is exposed; the CCTP path does not use signMessage or signAllTransactions.
export function createStrictSolanaProvider(provider: PhantomSolanaProvider, expected: SolanaTxExpectation) {
  const address = () => { const key = provider.publicKey; return key ? (typeof key.toBase58 === 'function' ? key.toBase58() : key.toString()) : null }
  return {
    get isConnected() { return Boolean(provider.isConnected) },
    get publicKey() { const a = address(); return a ? { toString: () => a } : undefined },
    connect: async () => {
      const result = await provider.connect()
      const key = result.publicKey
      const a = key ? (typeof key.toBase58 === 'function' ? key.toBase58() : key.toString()) : address()
      if (!a) throw new Error('Solana wallet did not return an address.')
      return { publicKey: { toString: () => a } }
    },
    disconnect: async () => provider.disconnect(),
    signTransaction: async (transaction: unknown) => {
      if (!provider.signTransaction) throw new Error('Connected Solana wallet cannot sign transactions.')
      if (address() !== expected.owner) throw new SolanaTxPolicyError('wallet', 'The connected Phantom wallet changed.')
      assertSolanaBridgeTransaction(transaction, expected)
      return provider.signTransaction(transaction)
    },
  }
}
