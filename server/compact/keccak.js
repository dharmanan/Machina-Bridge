// Compact engine: Keccak-256 with the original (pre-NIST) padding Ethereum uses, so event topics and function selectors
// are derived from their canonical signatures instead of copied as magic constants. Pure JavaScript on BigInt lanes; it
// runs once per signature when a protocol definition loads, never per block or per log.
const MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n, 0x000000000000808Bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800An, 0x800000008000000An, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offset of lane (x, y) at index x + 5y.
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl = (value, shift) => (shift === 0n ? value : ((value << shift) | (value >> (64n - shift))) & MASK);

function permute(state) {
  for (const constant of ROUND_CONSTANTS) {
    const parity = [0, 1, 2, 3, 4].map((x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    for (let x = 0; x < 5; x++) {
      const delta = parity[(x + 4) % 5] ^ rotl(parity[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= delta;
    }
    const moved = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATIONS[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) state[x + y] = moved[x + y] ^ (~moved[((x + 1) % 5) + y] & MASK & moved[((x + 2) % 5) + y]);
    }
    state[0] ^= constant;
  }
}

// keccak256 of a UTF-8 string or a Uint8Array, as 0x-prefixed lowercase hex.
export function keccak256(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE_BYTES) * RATE_BYTES);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      state[lane] ^= value;
    }
    permute(state);
  }
  let out = '0x';
  for (let lane = 0; lane < 4; lane++) {
    for (let byte = 0; byte < 8; byte++) out += Number((state[lane] >> BigInt(8 * byte)) & 0xffn).toString(16).padStart(2, '0');
  }
  return out;
}
