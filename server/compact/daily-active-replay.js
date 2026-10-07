import { headerOf, spineWindows } from './spine.js';

const HOUR = 3600;
const HASH = /^0x[0-9a-f]{64}$/;
const hex = (number) => `0x${number.toString(16)}`;

export async function replayHourActiveAddresses({ provider, hour }) {
  if (
    !provider ||
    !Number.isSafeInteger(hour?.hourStart) ||
    hour.hourStart % HOUR !== 0 ||
    !Number.isSafeInteger(hour.firstBlock) ||
    !Number.isSafeInteger(hour.lastBlock) ||
    hour.lastBlock < hour.firstBlock ||
    !HASH.test(hour.parentHash) ||
    !HASH.test(hour.lastHash)
  ) {
    throw new Error('invalid_dau_replay_hour');
  }

  const before = headerOf(
    await provider.request('eth_getBlockByNumber', [hex(hour.firstBlock - 1), false]),
    hour.firstBlock - 1,
  );

  if (before.hash !== hour.parentHash) {
    throw new Error('dau_replay_parent_hash_mismatch');
  }

  const addresses = new Set();
  let lastHash = null;

  for await (const blocks of spineWindows(provider, {
    first: hour.firstBlock,
    last: hour.lastBlock,
    before,
    hourStart: hour.hourStart,
    hourEnd: hour.hourStart + HOUR,
  })) {
    for (const block of blocks) {
      lastHash = block.hash;
      for (let i = 0; i < block.txFrom.length; i++) {
        addresses.add(block.txFrom[i]);
        if (block.txTo[i]) addresses.add(block.txTo[i]);
      }
    }
  }

  if (lastHash !== hour.lastHash) {
    throw new Error('dau_replay_last_hash_mismatch');
  }

  return [...addresses].sort();
}
