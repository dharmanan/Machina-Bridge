// Compact engine: shared pieces of the protocol families. Bounded keyed tallies (a family becomes unavailable past its key
// limit, so memory and row size stay bounded), exact raw-amount sums, and eth_call batches in which an RPC error, a revert
// or a malformed result makes the family unavailable instead of becoming a value.
import { FamilyError } from '../family-error.js';
import { ProviderError } from '../provider.js';

// Top-level sender of the transaction that emitted a validated log.
export const senderOf = (window, log) => window.get(log.blockNumber).txFrom[log.transactionIndex];

// Counters (numbers) and raw amounts (BigInt, emitted as decimal strings) per key, plus constant metadata per key.
// Every key present had at least one event this hour, so its zero fields are evidence, not missing data.
export function createTally({ limit, code, counts = [], amounts = [] }) {
  const entries = new Map();
  return {
    add(key, increments, meta = {}) {
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= limit) throw new FamilyError(code);
        entry = { meta, values: Object.fromEntries([...counts.map((field) => [field, 0]), ...amounts.map((field) => [field, 0n])]) };
        entries.set(key, entry);
      }
      for (const [field, value] of Object.entries(increments)) entry.values[field] += value;
    },
    keys: () => [...entries.keys()],
    setMeta(key, meta) { Object.assign(entries.get(key).meta, meta); },
    toObject() {
      return Object.fromEntries([...entries.keys()].sort().map((key) => {
        const { meta, values } = entries.get(key);
        return [key, { ...meta, ...Object.fromEntries(Object.entries(values)
          .map(([field, value]) => [field, typeof value === 'bigint' ? value.toString(10) : value])) }];
      }));
    },
  };
}

// eth_call each { to, data } at blockTag, 50 calls per batch. Any failure is the family's `code`, never a value.
export async function readViews(provider, calls, blockTag, code) {
  const results = [];
  for (let offset = 0; offset < calls.length; offset += 50) {
    try {
      results.push(...await provider.batch(calls.slice(offset, offset + 50).map((call) => ['eth_call', [call, blockTag]])));
    } catch (error) {
      if (error instanceof ProviderError) throw new FamilyError(code);
      throw error;
    }
  }
  return results;
}

// A bytes32 that holds an EVM address (12 leading zero bytes), as a lowercase address; otherwise null.
export const bytes32Address = (value) => (/^0x0{24}[0-9a-f]{40}$/.test(value) ? `0x${value.slice(26)}` : null);

export const requireCode = (context, addresses, code) => {
  if (!addresses.every((address) => context.codePresent(address))) throw new FamilyError(code);
};
