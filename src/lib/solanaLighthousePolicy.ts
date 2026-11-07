// Strict decoder for the Lighthouse assertion instructions Phantom may add to a transaction it signs
// (docs.phantom.com/developer-powertools/lighthouse). Only the read-only assertion types whose format and
// effect were verified are accepted; everything else is refused before anything is broadcast.
//
// Evidence (read-only, see the reclaim PR): program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 is
// immutable (upgrade authority none) and its on-chain executable hash
// b70084e0d1de4a551c2bf9740a9b5012600edb98b56fd84065f0e8f47762529a matches the OtterSec verified build of
// github.com/jac0xb/lighthouse. In that source, AssertAccountData(2), AssertAccountDataMulti(3),
// AssertAccountInfo(5) and AssertAccountInfoMulti(6) load one target account and only read it.
// AssertSysvarClock(15) loads no account ("No accounts" in instruction.rs) and reads the clock through the
// Clock::get() syscall; a passed account is ignored. The only CPI of these types is the optional log to
// SPL Noop with no accounts. Layout: Borsh, u8 enum tags, CompactU64 = unsigned LEB128, vectors
// LEB128-length prefixed.
//
// Not accepted: MemoryWrite(0)/MemoryClose(1) (writable payer signer, rent from the wallet), AssertAccountDelta(4),
// token/mint/stake/loader/merkle types and unknown types.

export const LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
export const SYSVAR_CLOCK_ID = 'SysvarC1ock11111111111111111111111111111111'

export const LIGHTHOUSE_INSTRUCTION_NAMES = [
  'MemoryWrite', 'MemoryClose', 'AssertAccountData', 'AssertAccountDataMulti', 'AssertAccountDelta',
  'AssertAccountInfo', 'AssertAccountInfoMulti', 'AssertMintAccount', 'AssertMintAccountMulti',
  'AssertTokenAccount', 'AssertTokenAccountMulti', 'AssertStakeAccount', 'AssertStakeAccountMulti',
  'AssertUpgradeableLoaderAccount', 'AssertUpgradeableLoaderAccountMulti', 'AssertSysvarClock',
  'AssertMerkleTreeAccount', 'AssertBubblegumTreeConfigAccount',
] as const

// Read-only assertions with a verified format. 2, 3, 5, 6 take exactly one target account; 15 takes none,
// or only the read-only Clock sysvar (lighthouseAccountRule).
export const LIGHTHOUSE_ALLOWED_TYPES: ReadonlySet<number> = new Set([2, 3, 5, 6, 15])
export const LIGHTHOUSE_CLOCK_TYPE = 15

export function lighthouseAccountRule(type: number): 'one-target' | 'clock-only' {
  return type === LIGHTHOUSE_CLOCK_TYPE ? 'clock-only' : 'one-target'
}

const LOG_LEVELS = 7 // Silent .. FailedEncodedNoop
const EQUATABLE_OPERATORS = 2
const INTEGER_OPERATORS = 8
const KNOWN_PROGRAMS = 9
const MAX_MULTI_ASSERTIONS = 16
const MAX_BYTES_VALUE = 1024

export class LighthousePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LighthousePolicyError'
  }
}

export function lighthouseInstructionName(type: number | undefined): string {
  return type !== undefined && type < LIGHTHOUSE_INSTRUCTION_NAMES.length ? LIGHTHOUSE_INSTRUCTION_NAMES[type] : `unknown type ${type ?? '?'}`
}

class Reader {
  private offset = 0
  constructor(private readonly data: Uint8Array) {}
  u8(): number {
    if (this.offset >= this.data.length) throw new LighthousePolicyError('the assertion data ends early')
    return this.data[this.offset++]
  }
  skip(bytes: number) {
    if (this.offset + bytes > this.data.length) throw new LighthousePolicyError('the assertion data ends early')
    this.offset += bytes
  }
  enumTag(count: number, what: string) {
    const v = this.u8()
    if (v >= count) throw new LighthousePolicyError(`invalid ${what}`)
    return v
  }
  bool() {
    const v = this.u8()
    if (v > 1) throw new LighthousePolicyError('invalid boolean')
  }
  // Unsigned LEB128 (CompactU64), at most 8 bytes and within the safe integer range.
  leb128(): number {
    let value = 0, shift = 1
    for (let i = 0; i < 8; i += 1) {
      const b = this.u8()
      value += (b & 0x7f) * shift
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new LighthousePolicyError('non-canonical length encoding')
        if (!Number.isSafeInteger(value)) throw new LighthousePolicyError('length out of range')
        return value
      }
      shift *= 128
    }
    throw new LighthousePolicyError('length out of range')
  }
  done() {
    if (this.offset !== this.data.length) throw new LighthousePolicyError('unexpected trailing assertion data')
  }
}

function accountInfoAssertion(r: Reader) {
  const variant = r.enumTag(9, 'account info assertion')
  switch (variant) {
    case 0: case 1: case 4: // Lamports, DataLength, RentEpoch: u64 + integer operator
      r.skip(8); r.enumTag(INTEGER_OPERATORS, 'integer operator'); return
    case 2: // Owner: pubkey + equatable operator
      r.skip(32); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator'); return
    case 3: // KnownOwner
      r.enumTag(KNOWN_PROGRAMS, 'known program'); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator'); return
    case 5: case 6: case 7: // IsSigner, IsWritable, Executable
      r.bool(); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator'); return
    default: // 8 VerifyDatahash: 32-byte hash + start + length
      r.skip(32); r.leb128(); r.leb128()
  }
}

const DATA_VALUE_WIDTH = [1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 16] // Bool, U8, I8, U16, I16, U32, I32, U64, I64, U128, I128
function dataValueAssertion(r: Reader) {
  const variant = r.enumTag(13, 'data value assertion')
  if (variant === 0) { r.bool(); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator'); return }
  if (variant <= 10) { r.skip(DATA_VALUE_WIDTH[variant]); r.enumTag(INTEGER_OPERATORS, 'integer operator'); return }
  if (variant === 11) { // Bytes
    const length = r.leb128()
    if (length > MAX_BYTES_VALUE) throw new LighthousePolicyError('byte assertion too long')
    r.skip(length); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator'); return
  }
  r.skip(32); r.enumTag(EQUATABLE_OPERATORS, 'equatable operator') // 12 Pubkey
}

function multi(r: Reader, item: (r: Reader) => void) {
  const count = r.leb128()
  if (count < 1 || count > MAX_MULTI_ASSERTIONS) throw new LighthousePolicyError('invalid number of assertions')
  for (let i = 0; i < count; i += 1) item(r)
}

// Decodes the whole instruction data of an allowed type; refuses any other type or a malformed body.
export function decodeLighthouseAssertion(data: Uint8Array): { type: number; name: string } {
  const type = data[0]
  const name = lighthouseInstructionName(type)
  if (type === undefined || !LIGHTHOUSE_ALLOWED_TYPES.has(type)) throw new LighthousePolicyError(`Lighthouse ${name} is not an allowed read-only assertion`)
  const r = new Reader(data)
  r.u8()
  try {
    r.enumTag(LOG_LEVELS, 'log level')
    if (type === 15) { r.enumTag(5, 'clock assertion'); r.skip(8); r.enumTag(INTEGER_OPERATORS, 'integer operator') } // Slot, EpochStartTimestamp, Epoch, LeaderScheduleEpoch, UnixTimestamp
    else if (type === 5) accountInfoAssertion(r)
    else if (type === 6) multi(r, accountInfoAssertion)
    else if (type === 2) { r.leb128(); dataValueAssertion(r) }
    else multi(r, (x) => { x.leb128(); dataValueAssertion(x) }) // 3: (offset, assertion)[]
    r.done()
  } catch (error) {
    throw new LighthousePolicyError(`Lighthouse ${name} has a malformed body (${error instanceof Error ? error.message : 'invalid'})`)
  }
  return { type, name }
}
