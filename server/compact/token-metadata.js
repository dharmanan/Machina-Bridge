// Compact engine: ERC-20 metadata (symbol, name, decimals) of tokens the indexer has met in verified Uniswap pools, read
// from the public Arc RPC with eth_call and cached in SQLite (store.js compact_token_metadata). Display data only: it
// never names a verified asset (the verified asset registry and Arc's native USDC do, and they are never read here), it
// never feeds a price or a USD value, and it is never read on a dashboard request.
// A token is read at most once. A valid answer is cached as verified; a deterministic failure (no contract or no return
// data, a revert, a malformed answer, decimals out of range, or a symbol or name that imitates a verified Arc asset) is
// cached as rejected with symbol, name and decimals null. A transport, rate-limit or other node error caches nothing, so
// the token is tried again on a later run. Each run reads at most METADATA_TOKENS_PER_RUN tokens, three calls per token in
// batches of at most 50 calls: at most two batched requests per run.
import { ARC_VERIFIED_ASSETS } from '../../api/_lib/arc-intelligence/assets.js';
import { ProviderError } from './provider.js';

export const TOKEN_METADATA_VERSION = 'erc20-symbol-name-decimals-eth-call-v1';
export const METADATA_TOKENS_PER_RUN = 32;
export const METADATA_CALLS_PER_TOKEN = 3;
export const METADATA_TOKENS_PER_BATCH = Math.floor(50 / METADATA_CALLS_PER_TOKEN);
export const MAX_TOKEN_DECIMALS = 36;
export const METADATA_REJECT_REASONS = Object.freeze(['no_return_data', 'reverted', 'malformed_symbol', 'malformed_decimals',
  'decimals_out_of_range', 'imitates_verified_asset']);
const SELECTORS = Object.freeze({ symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' });
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._+$-]{0,19}$/;
const NAME = /^[\x20-\x7e]{1,64}$/;
// Never shown for another contract: the symbols of the verified Arc assets and the names Circle uses for them.
const IMITATION = new RegExp([...ARC_VERIFIED_ASSETS.map((asset) => asset.symbol.toLowerCase()), 'usd coin', 'euro coin', 'circle']
  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
const VERIFIED = new Set(ARC_VERIFIED_ASSETS.map((asset) => asset.address));
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

// Tokens that are never read here: their identity is already verified (registry assets and Arc's native currency).
export const metadataExempt = (token) => token === ZERO_ADDRESS || VERIFIED.has(token);

const wordAt = (hex, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);

// ABI decoding, strict. A string is either the standard dynamic encoding (offset 32, length, zero-padded bytes, nothing
// after) or a legacy bytes32 (text then zero bytes only). Only printable ASCII is accepted. Returns null otherwise.
export function decodeAbiText(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length < 66) return null;
  let bytes;
  if (hex.length === 66) {
    bytes = Buffer.from(hex.slice(2), 'hex');
    const end = bytes.indexOf(0);
    if (end !== -1 && bytes.subarray(end).some((byte) => byte !== 0)) return null;
    bytes = end === -1 ? bytes : bytes.subarray(0, end);
  } else {
    if (BigInt(`0x${wordAt(hex, 0)}`) !== 32n || hex.length < 130) return null;
    const length = BigInt(`0x${wordAt(hex, 1)}`);
    if (length > 256n) return null;
    const size = Number(length);
    if (hex.length !== 130 + Math.ceil(size / 32) * 64) return null;
    const data = Buffer.from(hex.slice(130), 'hex');
    if (data.subarray(size).some((byte) => byte !== 0)) return null;
    bytes = data.subarray(0, size);
  }
  if (!bytes.length || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) return null;
  return bytes.toString('latin1');
}

// decimals(): exactly one 32-byte word.
export function decodeAbiUint(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]{64}$/.test(hex)) return null;
  return BigInt(hex);
}

// One eth_call answer: { value } | { failure: 'no_return_data' | 'reverted' } | { transient: true }.
function answerOf(item) {
  if (!item) return { transient: true };
  if (item.error) {
    const message = String(item.error.message ?? '');
    return item.error.code === 3 || /revert/i.test(message) ? { failure: 'reverted' } : { transient: true };
  }
  if (typeof item.result !== 'string') return { transient: true };
  const value = item.result.toLowerCase();
  return value === '0x' ? { failure: 'no_return_data' } : { value };
}

// Metadata of one token from its three answers, or null when any required answer is transient (nothing is cached).
export function metadataOf(token, { symbol: symbolItem, name: nameItem, decimals: decimalsItem }) {
  const answers = { symbol: answerOf(symbolItem), name: answerOf(nameItem), decimals: answerOf(decimalsItem) };
  if (answers.symbol.transient || answers.decimals.transient || answers.name.transient) return null;
  const rejected = (reason) => ({ token, verified: false, symbol: null, name: null, decimals: null, reason });
  if (answers.symbol.failure) return rejected(answers.symbol.failure);
  if (answers.decimals.failure) return rejected(answers.decimals.failure);
  const symbol = decodeAbiText(answers.symbol.value);
  if (symbol === null || !SYMBOL.test(symbol)) return rejected('malformed_symbol');
  const decimals = decodeAbiUint(answers.decimals.value);
  if (decimals === null) return rejected('malformed_decimals');
  if (decimals > BigInt(MAX_TOKEN_DECIMALS)) return rejected('decimals_out_of_range');
  // name() is optional in ERC-20: a missing or malformed name is simply absent.
  const rawName = answers.name.value === undefined ? null : decodeAbiText(answers.name.value);
  const name = rawName !== null && NAME.test(rawName) && rawName.trim() === rawName ? rawName : null;
  if (IMITATION.test(symbol) || (name !== null && IMITATION.test(name))) return rejected('imitates_verified_asset');
  return { token, verified: true, symbol, name, decimals: Number(decimals), reason: null };
}

// Reads the metadata of `tokens` (lowercase addresses, none exempt) at `blockTag`. Returns { rows, skipped, requests }:
// rows to cache (verified or rejected), skipped tokens with a transient answer. A batch-level provider failure stops the
// run and is thrown after `onBatch` has already received every finished batch.
export async function readTokenMetadata(provider, tokens, { blockTag, onBatch = () => {} }) {
  if (!tokens.every((token) => ADDRESS.test(token) && !metadataExempt(token))) throw new Error('invalid_metadata_tokens');
  if (typeof blockTag !== 'string' || !/^0x[0-9a-f]+$/.test(blockTag)) throw new Error('invalid_metadata_block');
  const rows = [];
  const skipped = [];
  let requests = 0;
  for (let offset = 0; offset < tokens.length; offset += METADATA_TOKENS_PER_BATCH) {
    const chunk = tokens.slice(offset, offset + METADATA_TOKENS_PER_BATCH);
    const calls = chunk.flatMap((token) => ['symbol', 'name', 'decimals'].map((method) => ['eth_call', [{ to: token, data: SELECTORS[method] }, blockTag]]));
    requests += 1;
    const answers = await provider.batch(calls, { allowItemErrors: true });
    const batch = [];
    chunk.forEach((token, index) => {
      const [symbol, name, decimals] = answers.slice(index * 3, index * 3 + 3);
      const row = metadataOf(token, { symbol, name, decimals });
      if (row) batch.push(row);
      else skipped.push(token);
    });
    rows.push(...batch);
    onBatch(batch);
  }
  return { rows, skipped, requests };
}

// The bounded per-run step: tokens without cached metadata (store.tokensNeedingMetadata), read once and cached. Never
// throws: any failure is reported, and what finished before it stays cached.
export async function refreshTokenMetadata({ store, provider, blockNumber, limit = METADATA_TOKENS_PER_RUN }) {
  const report = { candidates: 0, verified: 0, rejected: 0, skipped: 0, requests: 0, error: null };
  try {
    // Never more than METADATA_TOKENS_PER_RUN tokens per run, whatever the caller asks for.
    const cap = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 0, METADATA_TOKENS_PER_RUN);
    if (!cap) return report;
    const tokens = store.tokensNeedingMetadata({ limit: cap }).filter((token) => !metadataExempt(token)).slice(0, cap);
    report.candidates = tokens.length;
    if (!tokens.length) return report;
    const blockTag = `0x${blockNumber.toString(16)}`;
    const result = await readTokenMetadata(provider, tokens, { blockTag, onBatch: (batch) => {
      report.requests += 1;
      if (batch.length) store.recordTokenMetadata(batch, { readBlock: blockNumber });
      for (const row of batch) report[row.verified ? 'verified' : 'rejected'] += 1;
    } });
    report.skipped = result.skipped.length;
  } catch (error) {
    report.error = error instanceof ProviderError ? `provider_${error.code}` : error?.code ?? error?.message ?? 'metadata_error';
  }
  return report;
}
