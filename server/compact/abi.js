// Compact engine: strict, minimal Solidity ABI support for protocol families. An event is declared once, as its
// human-readable signature; its canonical signature, topic and decoder all derive from that one string, so a topic can
// never drift from the layout used to decode it. Decoding accepts canonical encodings only: a wrong topic count, a dirty
// address word, an out-of-range integer, a non-canonical dynamic tail or trailing data returns null, never a partial
// value. Supported: address, bool, bytes32, intN/uintN, tuples of those, and (non-indexed) bytes/string, whose content is
// validated and then dropped (only its byte length is kept).
import { keccak256 } from './keccak.js';

const INTEGER = /^(u?)int(\d{1,3})$/;
const STATIC = new Set(['address', 'bool', 'bytes32']);
const DYNAMIC = new Set(['bytes', 'string']);
const ADDRESS_WORD = /^0{24}[0-9a-f]{40}$/;

function closingParen(text, open) {
  for (let index = open, depth = 0; index < text.length; index++) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return index;
  }
  throw new Error('abi_unbalanced_parentheses');
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') depth -= 1;
    else if (text[index] === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function staticType(type) {
  const integer = INTEGER.exec(type);
  if (integer) {
    const bits = Number(integer[2]);
    if (bits < 8 || bits > 256 || bits % 8) throw new Error(`abi_unsupported_type:${type}`);
    return true;
  }
  return STATIC.has(type);
}

// 'address indexed token' | 'uint256 amount' | '(bytes32 a, uint8 b) info'
function parseParam(text) {
  let type;
  let components = null;
  let rest;
  if (text.startsWith('(')) {
    const close = closingParen(text, 0);
    components = splitTopLevel(text.slice(1, close)).map(parseParam);
    if (components.some((component) => component.components || !staticType(component.type) || component.indexed)) {
      throw new Error('abi_unsupported_tuple');
    }
    type = `(${components.map((component) => component.type).join(',')})`;
    rest = text.slice(close + 1).trim().split(/\s+/).filter(Boolean);
  } else {
    [type, ...rest] = text.split(/\s+/);
    if (!staticType(type) && !DYNAMIC.has(type)) throw new Error(`abi_unsupported_type:${type}`);
  }
  const indexed = rest[0] === 'indexed';
  const name = indexed ? rest[1] : rest[0];
  if (!name || rest.length !== (indexed ? 2 : 1)) throw new Error(`abi_malformed_param:${text}`);
  const dynamic = DYNAMIC.has(type);
  if (indexed && (dynamic || components)) throw new Error(`abi_unsupported_indexed:${type}`);
  return { name, type, indexed, dynamic, components };
}

// One 32-byte word (64 hex chars, no 0x) as a value of a static type, or null if the word is not its canonical encoding.
export function decodeWord(type, word) {
  if (typeof word !== 'string' || !/^[0-9a-f]{64}$/.test(word)) return null;
  if (type === 'address') return ADDRESS_WORD.test(word) ? `0x${word.slice(24)}` : null;
  if (type === 'bytes32') return `0x${word}`;
  const value = BigInt(`0x${word}`);
  if (type === 'bool') return value === 0n ? false : value === 1n ? true : null;
  const [, unsigned, bits] = INTEGER.exec(type);
  if (unsigned) return value < (1n << BigInt(bits)) ? value : null;
  const signed = BigInt.asIntN(Number(bits), value);
  return BigInt.asUintN(256, signed) === value ? signed : null;
}

function decodeData(inputs, data) {
  if (!/^0x([0-9a-f]{64})*$/.test(data)) return null;
  const hex = data.slice(2);
  const words = hex.length / 64;
  const word = (index) => hex.slice(index * 64, index * 64 + 64);
  const headWords = inputs.reduce((sum, input) => sum + (input.components ? input.components.length : 1), 0);
  if (words < headWords) return null;
  const values = {};
  let head = 0;
  let tail = headWords; // canonical encoding: each dynamic tail starts where the previous one ended
  for (const input of inputs) {
    if (input.components) {
      const tuple = {};
      for (const component of input.components) {
        const value = decodeWord(component.type, word(head++));
        if (value === null) return null;
        tuple[component.name] = value;
      }
      values[input.name] = tuple;
    } else if (input.dynamic) {
      if (BigInt(`0x${word(head++)}`) !== BigInt(tail * 32) || tail >= words) return null;
      const length = BigInt(`0x${word(tail)}`);
      if (length > BigInt((words - tail - 1) * 32)) return null;
      const contentWords = Math.ceil(Number(length) / 32);
      const start = (tail + 1) * 64;
      if (/[^0]/.test(hex.slice(start + Number(length) * 2, start + contentWords * 64))) return null;
      values[input.name] = { byteLength: Number(length) };
      tail += 1 + contentWords;
    } else {
      const value = decodeWord(input.type, word(head++));
      if (value === null) return null;
      values[input.name] = value;
    }
  }
  return tail === words ? values : null;
}

// 'event Name(type [indexed] name, ...)' -> { name, signature, topic, inputs, decode(log) }.
// decode takes a normalized log (lowercase hex topics and data) and returns its arguments, or null.
export function defineEvent(declaration) {
  const match = /^event\s+(\w+)\s*\((.*)\)$/s.exec(declaration.trim());
  if (!match) throw new Error(`abi_malformed_event:${declaration}`);
  const inputs = splitTopLevel(match[2]).map(parseParam);
  const signature = `${match[1]}(${inputs.map((input) => input.type).join(',')})`;
  const topic = keccak256(signature);
  const indexed = inputs.filter((input) => input.indexed);
  const unindexed = inputs.filter((input) => !input.indexed);
  return Object.freeze({
    name: match[1],
    signature,
    topic,
    inputs,
    decode(log) {
      if (!Array.isArray(log?.topics) || log.topics[0] !== topic || log.topics.length !== 1 + indexed.length) return null;
      const values = decodeData(unindexed, log.data);
      if (!values) return null;
      for (const [index, input] of indexed.entries()) {
        const value = decodeWord(input.type, log.topics[index + 1]?.slice(2));
        if (value === null) return null;
        values[input.name] = value;
      }
      return values;
    },
  });
}

// 4-byte selector of a canonical function signature, e.g. 'getReserve(uint256)'.
export const selectorOf = (signature) => keccak256(signature).slice(0, 10);

// Calldata for a view taking static arguments only: [['uint256', 5n], ['address', '0x..'], ['bytes32', '0x..']].
export function encodeCall(signature, args = []) {
  const words = args.map(([type, value]) => {
    if (type === 'address') return value.slice(2).toLowerCase().padStart(64, '0');
    if (type === 'bytes32') return value.slice(2).toLowerCase();
    return BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
  });
  return `${selectorOf(signature)}${words.join('')}`;
}

// A view result of exactly `types.length` static words, decoded; null for anything else (wrong length, dirty word).
export function decodeResult(types, result) {
  if (typeof result !== 'string' || !new RegExp(`^0x[0-9a-f]{${types.length * 64}}$`).test(result.toLowerCase())) return null;
  const hex = result.slice(2).toLowerCase();
  const values = types.map((type, index) => decodeWord(type, hex.slice(index * 64, index * 64 + 64)));
  return values.includes(null) ? null : values;
}
