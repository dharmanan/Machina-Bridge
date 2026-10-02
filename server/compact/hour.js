// Compact engine: deterministic historical hour processor. Input: a UTC hour start and a finalized safe head to search
// under. Output: one normalized in-memory result for that complete hour, or HourIncompleteError. A spine problem never
// yields a partial result; a log family that cannot be verified is reported unavailable with null values, never zero.
import { UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { locateHourBlocks } from './boundary.js';
import {
  codeIsPresent, createAssetsAccumulator, createNetworkAccumulator, createUniswapV3Accumulator, createUniswapV4Accumulator,
  createUsdcAccumulator, FAMILY_FIELDS, FamilyError,
} from './families.js';
import { fetchStreamLogs, LogError, validateStreamLogs } from './logs.js';
import { ARC_CHAIN_ID, ProviderError } from './provider.js';
import { COMPACT_DEFINITION_VERSION, COMPACT_SOURCE_VERSIONS, FAMILY_STREAMS, LOG_STREAMS } from './sources.js';
import { headerOf, SpineError, spineWindows } from './spine.js';

export const HOUR_SECONDS = 3600;
export const DEFAULT_WINDOW_BLOCKS = 1000;
const BOUNDARY_CODES = new Set(['invalid_hour_request', 'hour_not_finalized', 'hour_has_no_blocks', 'boundary_search_exhausted',
  'boundary_header_invalid', 'boundary_rate_unavailable', 'boundary_bracket_failed']);
const FAMILY_OF_STREAM = Object.fromEntries(Object.entries(FAMILY_STREAMS)
  .flatMap(([family, streams]) => streams.map((stream) => [stream, family])));
const hex = (number) => `0x${number.toString(16)}`;
const isoOf = (seconds) => (seconds === null ? null : new Date(seconds * 1000).toISOString());

export class HourIncompleteError extends Error {
  constructor(code, blockNumber = null) { super(code); this.code = code; this.blockNumber = blockNumber; }
}

const familyFailure = (error) => error instanceof LogError || error instanceof FamilyError || error instanceof ProviderError;

// Any contiguous finalized range. hourStart/hourEnd (both or neither) add the hour-membership check and throughput.
// onLogs (optional, for validation tooling) sees each window's validated logs per stream; it must not keep them all.
export async function processBlockRange({ provider, first, last, before, after = null, hourStart = null, hourEnd = null,
  windowBlocks = DEFAULT_WINDOW_BLOCKS, streams = LOG_STREAMS, onLogs = null }) {
  const network = createNetworkAccumulator();
  const families = {
    usdc: { accumulator: createUsdcAccumulator(), error: null },
    assets: { accumulator: createAssetsAccumulator(), error: null },
    uniswapV3: { accumulator: createUniswapV3Accumulator(), error: null },
    uniswapV4: { accumulator: createUniswapV4Accumulator(), error: null },
  };
  let firstBlock = null;
  let lastBlock = null;
  try {
    for await (const blocks of spineWindows(provider, { first, last, before, hourStart, hourEnd, windowBlocks })) {
      network.addBlocks(blocks);
      firstBlock ??= blocks[0];
      lastBlock = blocks.at(-1);
      const fromBlock = blocks[0].number;
      const toBlock = lastBlock.number;
      const spine = new Map(blocks.map((block) => [block.number, block]));
      const seen = new Set();
      for (const stream of streams) {
        const family = families[FAMILY_OF_STREAM[stream.key]];
        if (family.error) continue;
        try {
          const raw = await fetchStreamLogs(provider, stream, fromBlock, toBlock);
          const logs = validateStreamLogs(raw, stream, { fromBlock, toBlock, spine, seen });
          family.accumulator.add(stream.key, logs);
          onLogs?.(stream.key, logs);
        } catch (error) {
          if (!familyFailure(error)) throw error;
          family.error = error.code;
        }
      }
    }
  } catch (error) {
    if (error instanceof SpineError || error instanceof ProviderError) throw new HourIncompleteError(error.code, error.blockNumber ?? null);
    throw error;
  }
  if (!lastBlock || lastBlock.number !== last) throw new HourIncompleteError('spine_incomplete');
  if (after && (after.number !== last + 1 || after.parentHash !== lastBlock.hash || (hourEnd !== null && after.timestamp < hourEnd))) {
    throw new HourIncompleteError('right_boundary_mismatch', last + 1);
  }

  const blockTag = hex(last);
  let code = {};
  if (!families.uniswapV3.error || !families.uniswapV4.error) {
    try {
      const [factory, poolManager] = await provider.batch([['eth_getCode', [UNISWAP_REGISTRY.v3Factory.address, blockTag]],
        ['eth_getCode', [UNISWAP_REGISTRY.v4PoolManager.address, blockTag]]]);
      code = { factoryCodePresent: codeIsPresent(factory), poolManagerCodePresent: codeIsPresent(poolManager) };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      families.uniswapV3.error ??= 'contract_code_unavailable';
      families.uniswapV4.error ??= 'contract_code_unavailable';
    }
  }
  const results = {};
  for (const [name, family] of Object.entries(families)) {
    if (!family.error) {
      try {
        results[name] = { status: 'available', ...(await family.accumulator.finish({ provider, blockTag, ...code })) };
        continue;
      } catch (error) {
        if (!familyFailure(error)) throw error;
        family.error = error.code;
      }
    }
    results[name] = { status: 'unavailable', reason: family.error, ...Object.fromEntries(FAMILY_FIELDS[name].map((field) => [field, null])) };
  }

  return {
    definitionVersion: COMPACT_DEFINITION_VERSION,
    sourceVersions: COMPACT_SOURCE_VERSIONS,
    chainId: ARC_CHAIN_ID,
    range: {
      kind: hourStart === null ? 'blocks' : 'hour',
      hourStart,
      hourEnd,
      startUtc: isoOf(hourStart),
      endUtc: isoOf(hourEnd),
      firstBlock: firstBlock.number,
      lastBlock: lastBlock.number,
      firstHash: firstBlock.hash,
      lastHash: lastBlock.hash,
      firstTimestamp: firstBlock.timestamp,
      lastTimestamp: lastBlock.timestamp,
    },
    network: network.finish({ durationSeconds: hourStart === null ? null : HOUR_SECONDS }),
    families: results,
    complete: Object.values(results).every((family) => family.status === 'available'),
  };
}

// The result depends only on the hour: boundaries are exact, so any safe head past the hour gives the same answer.
export async function processHour({ provider, hourStart, safeHead, windowBlocks = DEFAULT_WINDOW_BLOCKS, onLogs = null }) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR_SECONDS !== 0) throw new HourIncompleteError('invalid_hour_request');
  const hourEnd = hourStart + HOUR_SECONDS;
  const headers = new Map();
  const header = async (number) => {
    if (!headers.has(number)) headers.set(number, headerOf(await provider.request('eth_getBlockByNumber', [hex(number), false]), number));
    return headers.get(number);
  };
  let bounds;
  try {
    bounds = await locateHourBlocks({ header, safeHead, hourStart, hourEnd });
  } catch (error) {
    if (error instanceof SpineError || error instanceof ProviderError) throw new HourIncompleteError(error.code, error.blockNumber ?? null);
    if (BOUNDARY_CODES.has(error?.message)) throw new HourIncompleteError(error.message);
    throw error;
  }
  const { before, first, last, after } = bounds;
  if (first.number !== before.number + 1 || after.number !== last.number + 1 || before.timestamp >= hourStart
    || first.timestamp < hourStart || last.timestamp >= hourEnd || after.timestamp < hourEnd) {
    throw new HourIncompleteError('boundary_invariant_failed');
  }
  const result = await processBlockRange({ provider, first: first.number, last: last.number, before, after, hourStart, hourEnd,
    windowBlocks, onLogs });
  if (result.range.firstHash !== first.hash || result.range.lastHash !== last.hash) throw new HourIncompleteError('boundary_hash_mismatch');
  return result;
}
