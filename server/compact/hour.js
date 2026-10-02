// Compact engine: deterministic historical hour processor. Input: a UTC hour start, a finalized safe head to search
// under, and the official Uniswap V3 pool registry. Output: one normalized in-memory result for that complete hour, or
// HourIncompleteError. A spine problem never yields a partial result; a log family that cannot be verified is reported
// unavailable with null values, never zero. Live memory is one 500-block window plus one log response, plus the hour's
// exact address sets: raw responses are validated, counted and released one at a time.
import { UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { locateHourBlocks } from './boundary.js';
import {
  createAssetsAccumulator, createNetworkAccumulator, createUniswapV3Accumulator, createUniswapV4Accumulator,
  createUsdcAccumulator, FAMILY_FIELDS, FamilyError,
} from './families.js';
import { LogError, streamLogs, validateLogs } from './logs.js';
import { ARC_CHAIN_ID, ProviderError } from './provider.js';
import { codeIsPresent } from './registry.js';
import { COMPACT_DEFINITION_VERSION, COMPACT_SOURCE_VERSIONS, DENSE_LOG_RANGE_BLOCKS, FAMILY_STREAMS, LOG_STREAMS } from './sources.js';
import { headerOf, SpineError, spineWindows } from './spine.js';

export const HOUR_SECONDS = 3600;
// One spine window per dense log request: a window never holds more blocks than one dense eth_getLogs covers.
export const DEFAULT_WINDOW_BLOCKS = DENSE_LOG_RANGE_BLOCKS;
const BOUNDARY_CODES = new Set(['invalid_hour_request', 'hour_not_finalized', 'hour_has_no_blocks', 'boundary_search_exhausted',
  'boundary_header_invalid', 'boundary_rate_unavailable', 'boundary_bracket_failed']);
const FAMILY_OF_STREAM = Object.fromEntries(Object.entries(FAMILY_STREAMS)
  .flatMap(([family, streams]) => streams.map((stream) => [stream, family])));
const hex = (number) => `0x${number.toString(16)}`;
const isoOf = (seconds) => (seconds === null ? null : new Date(seconds * 1000).toISOString());
const edgeOf = ({ number, hash, timestamp }) => ({ number, hash, timestamp });

export class HourIncompleteError extends Error {
  constructor(code, blockNumber = null) { super(code); this.code = code; this.blockNumber = blockNumber; }
}

const familyFailure = (error) => error instanceof LogError || error instanceof FamilyError || error instanceof ProviderError;

// V3 needs the registry to cover every block before the range; the range's own PoolCreated logs cover the rest.
function registryGap(registry, first, before) {
  if (!registry) return 'v3_registry_missing';
  if (registry.through < first - 1) return 'v3_registry_behind';
  if (registry.through === first - 1 && registry.throughHash !== before.hash) return 'v3_registry_fork';
  return null;
}

// Any contiguous finalized range. hourStart/hourEnd (both or neither) add the hour-membership check and throughput.
// v3Registry: { through, throughHash, pools: Set } (registry.js registrySnapshot or store.js v3Registry).
// streams: a subset only for bounded tests; a family missing any of its streams is unavailable, never zero.
// onLogs (optional, for validation tooling) sees each validated log response per stream; it must not keep them all.
export async function processBlockRange({ provider, first, last, before, after = null, hourStart = null, hourEnd = null,
  windowBlocks = DEFAULT_WINDOW_BLOCKS, streams = LOG_STREAMS, onLogs = null, v3Registry = null }) {
  const network = createNetworkAccumulator();
  const families = {
    usdc: { accumulator: createUsdcAccumulator(), error: null },
    assets: { accumulator: createAssetsAccumulator(), error: null },
    uniswapV3: { accumulator: createUniswapV3Accumulator({ registry: v3Registry }), error: registryGap(v3Registry, first, before) },
    uniswapV4: { accumulator: createUniswapV4Accumulator(), error: null },
  };
  const requested = new Set(streams.map((stream) => stream.key));
  for (const [name, family] of Object.entries(families)) {
    if (!FAMILY_STREAMS[name].every((key) => requested.has(key))) family.error = 'stream_not_requested';
  }
  let firstBlock = null;
  let lastBlock = null;
  try {
    for await (const blocks of spineWindows(provider, { first, last, before, hourStart, hourEnd, windowBlocks })) {
      network.addBlocks(blocks);
      firstBlock ??= edgeOf(blocks[0]);
      lastBlock = edgeOf(blocks.at(-1));
      const fromBlock = blocks[0].number;
      const toBlock = lastBlock.number;
      const window = new Map(blocks.map((block) => [block.number, block]));
      const seen = new Set();
      for (const stream of streams) {
        const family = families[FAMILY_OF_STREAM[stream.key]];
        if (family.error) continue;
        try {
          for await (const response of streamLogs(provider, stream, fromBlock, toBlock)) {
            const logs = validateLogs(response, stream, { fromBlock, toBlock, window, seen });
            family.accumulator.add(stream.key, logs, window);
            onLogs?.(stream.key, logs);
          }
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
        results[name] = { status: 'available', ...(await family.accumulator.finish(code)) };
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
      parentHash: before.hash,
      firstHash: firstBlock.hash,
      lastHash: lastBlock.hash,
      firstTimestamp: firstBlock.timestamp,
      lastTimestamp: lastBlock.timestamp,
    },
    network: network.finish({ durationSeconds: hourStart === null ? null : HOUR_SECONDS }),
    families: results,
    complete: Object.values(results).every((family) => family.status === 'available'),
    // Exact identity set behind network.uniqueActiveAddresses: the store keeps it only for rolling 6H/24H unions.
    activeAddresses: network.activeAddresses(),
    // Registry rows this range adds; only when V3 is available, i.e. its PoolCreated logs were all validated.
    registry: {
      uniswapV3: results.uniswapV3.status === 'available'
        ? { through: lastBlock.number, throughHash: lastBlock.hash, created: families.uniswapV3.accumulator.createdPools() } : null,
    },
  };
}

function checkedBounds(bounds, hourStart) {
  const { before, first, last, after } = bounds ?? {};
  const hourEnd = hourStart + HOUR_SECONDS;
  if (!before || !first || !last || !after || first.number !== before.number + 1 || after.number !== last.number + 1
    || before.timestamp >= hourStart || first.timestamp < hourStart || last.timestamp >= hourEnd || after.timestamp < hourEnd) {
    throw new HourIncompleteError('boundary_invariant_failed');
  }
  return bounds;
}

// Exact boundary headers { before, first, last, after } of a complete UTC hour under a finalized safe head.
export async function locateHour({ provider, hourStart, safeHead }) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR_SECONDS !== 0) throw new HourIncompleteError('invalid_hour_request');
  const headers = new Map();
  const header = async (number) => {
    if (!headers.has(number)) headers.set(number, headerOf(await provider.request('eth_getBlockByNumber', [hex(number), false]), number));
    return headers.get(number);
  };
  let bounds;
  try {
    bounds = await locateHourBlocks({ header, safeHead, hourStart, hourEnd: hourStart + HOUR_SECONDS });
  } catch (error) {
    if (error instanceof SpineError || error instanceof ProviderError) throw new HourIncompleteError(error.code, error.blockNumber ?? null);
    if (BOUNDARY_CODES.has(error?.message)) throw new HourIncompleteError(error.message);
    throw error;
  }
  return checkedBounds(bounds, hourStart);
}

// The result depends only on the hour: boundaries are exact, so any safe head past the hour gives the same answer, and
// any registry that covers the blocks before the hour classifies V3 emitters the same way. `bounds` (from locateHour)
// skips the boundary search; it is checked again here and the spine re-validates every block against it.
export async function processHour({ provider, hourStart, safeHead, windowBlocks = DEFAULT_WINDOW_BLOCKS, onLogs = null, v3Registry = null,
  bounds = null }) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR_SECONDS !== 0) throw new HourIncompleteError('invalid_hour_request');
  const hourEnd = hourStart + HOUR_SECONDS;
  const { before, first, last, after } = bounds ? checkedBounds(bounds, hourStart) : await locateHour({ provider, hourStart, safeHead });
  const result = await processBlockRange({ provider, first: first.number, last: last.number, before, after, hourStart, hourEnd,
    windowBlocks, onLogs, v3Registry });
  if (result.range.firstHash !== first.hash || result.range.lastHash !== last.hash) throw new HourIncompleteError('boundary_hash_mismatch');
  return result;
}
