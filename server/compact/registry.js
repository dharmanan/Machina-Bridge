// Compact engine: official Uniswap V3 pool registry, read from chain. A pool is official if and only if the official
// factory emitted PoolCreated for it (UniswapV3Factory.createPool sets getPool and emits the event in one call and never
// overwrites it), so no per-pool eth_call is needed. Coverage is explicit: a registry is complete from `fromBlock` through
// `through`, whose block hash is recorded. Past `through` nothing is assumed, and the hour processor reports V3
// unavailable rather than guessing. Rows are persisted by store.js; this module only reads chain.
// The Uniswap V4 pool registry (projection data, not a family) follows the same coverage rules: one row per PoolManager
// Initialize, keyed by poolId, kept only when poolId = keccak256(PoolKey) of the event's own fields.
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { decodeV3PoolCreated, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { LOG_MAX_RANGE_BLOCKS, LogError, streamLogs } from './logs.js';
import { v4PoolRecordOf, V4_POOL_KIND } from './projections.js';
import { LOG_STREAMS, V4_INITIALIZE_STREAM } from './sources.js';
import { headerOf } from './spine.js';

export const V3_POOL_KIND = 'uniswap_v3_pool';
const FACTORY = UNISWAP_REGISTRY.v3Factory.address;
const POOL_MANAGER = UNISWAP_REGISTRY.v4PoolManager.address;
const FACTORY_STREAM = LOG_STREAMS.find((stream) => stream.key === 'v3Factory');
const hex = (number) => `0x${number.toString(16)}`;

export class RegistryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const codeIsPresent = (code) => typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code);

// Registry row for one validated official PoolCreated log, or null when the log does not decode.
export function poolRecordOf(log) {
  const event = decodeV3PoolCreated(log);
  return event && { address: event.pool, createdBlock: log.blockNumber, createdLogIndex: log.logIndex, createdTx: log.transactionHash,
    token0: event.token0, token1: event.token1, fee: event.fee, tickSpacing: event.tickSpacing };
}

const header = async (provider, number) => headerOf(await provider.request('eth_getBlockByNumber', [hex(number), false]), number);

// Every official pool created in [fromBlock, toBlock], in chain order. There is no body spine here, so each block that
// holds a PoolCreated is checked against a fetched header (batched, 50 blocks per request; the logs are sparse).
async function scan(provider, fromBlock, toBlock) {
  const created = [];
  const hashes = new Map();
  const seen = new Set();
  const maxRequests = Math.ceil((toBlock - fromBlock + 1) / LOG_MAX_RANGE_BLOCKS) + 512;
  for await (const response of streamLogs(provider, FACTORY_STREAM, fromBlock, toBlock, { maxRequests })) {
    for (const raw of response) {
      if (raw?.removed === true) throw new LogError('removed_log');
      let log;
      try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new LogError('log_outside_range', log.blockNumber);
      if (log.address !== FACTORY || log.topics[0] !== UNISWAP_EVENT_TOPICS.v3PoolCreated || !log.blockHash || !log.transactionHash) {
        throw new LogError('unexpected_log', log.blockNumber);
      }
      if ((hashes.get(log.blockNumber) ?? log.blockHash) !== log.blockHash) throw new LogError('log_block_hash_mismatch', log.blockNumber);
      hashes.set(log.blockNumber, log.blockHash);
      if (seen.has(`${log.blockNumber}:${log.logIndex}`)) throw new LogError('duplicate_log', log.blockNumber);
      seen.add(`${log.blockNumber}:${log.logIndex}`);
      const record = poolRecordOf(log);
      if (!record) throw new RegistryError('malformed_v3_pool_created');
      created.push(record);
    }
  }
  if (new Set(created.map((pool) => pool.address)).size !== created.length) throw new RegistryError('duplicate_v3_pool_created');
  const numbers = [...hashes.keys()];
  for (let offset = 0; offset < numbers.length; offset += 50) {
    const chunk = numbers.slice(offset, offset + 50);
    const headers = await provider.batch(chunk.map((number) => ['eth_getBlockByNumber', [hex(number), false]]));
    chunk.forEach((number, index) => {
      if (headerOf(headers[index], number).hash !== hashes.get(number)) throw new RegistryError('registry_block_hash_mismatch');
    });
  }
  return created.sort((left, right) => left.createdBlock - right.createdBlock || left.createdLogIndex - right.createdLogIndex);
}

// First registry, [fromBlock, toBlock]. A start after block 0 must be proven to precede the factory deployment: no factory
// code at fromBlock - 1. If the RPC cannot answer that historical read, the bootstrap fails rather than assume.
export async function bootstrapV3Registry(provider, { fromBlock = 0, toBlock }) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
    throw new RegistryError('invalid_registry_range');
  }
  if (fromBlock > 0) {
    const code = await provider.request('eth_getCode', [FACTORY, hex(fromBlock - 1)]);
    if (typeof code !== 'string') throw new RegistryError('registry_start_unverified');
    if (codeIsPresent(code)) throw new RegistryError('registry_start_after_factory_deployment');
  }
  const created = await scan(provider, fromBlock, toBlock);
  return { kind: V3_POOL_KIND, fromBlock, previousThrough: null, through: toBlock, throughHash: (await header(provider, toBlock)).hash, created };
}

// Extends coverage to toBlock, after checking that the recorded coverage block is still this chain's block.
export async function catchUpV3Registry(provider, coverage, toBlock) {
  if (!coverage) throw new RegistryError('v3_registry_missing');
  if (!Number.isSafeInteger(toBlock) || toBlock <= coverage.through) return null;
  if ((await header(provider, coverage.through)).hash !== coverage.throughHash) throw new RegistryError('v3_registry_fork');
  const created = await scan(provider, coverage.through + 1, toBlock);
  return { kind: V3_POOL_KIND, fromBlock: coverage.fromBlock, previousThrough: coverage.through, through: toBlock,
    throughHash: (await header(provider, toBlock)).hash, created };
}

// In-memory registry view for the hour processor: { fromBlock, through, throughHash, pools: Set of pool addresses }.
// `base` is the snapshot a catch-up scan extends.
export function registrySnapshot(registryScan, base = null) {
  if (registryScan?.kind !== V3_POOL_KIND || registryScan.previousThrough !== (base?.through ?? null)) {
    throw new RegistryError('registry_discontinuity');
  }
  return { fromBlock: registryScan.fromBlock, through: registryScan.through, throughHash: registryScan.throughHash,
    pools: new Set([...(base?.pools ?? []), ...registryScan.created.map((pool) => pool.address)]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Uniswap V4 pool registry. Not run by the hour runner: bootstrap and catch-up are explicit, separately approved tooling
// (scripts/backfill-compact-projections.mjs). Live hours add their own validated Initialize rows on commit (store.js).

// Every V4 pool initialized in [fromBlock, toBlock], in chain order, in Initialize-only requests of up to 10,000 blocks.
// Each record must satisfy poolId = keccak256(PoolKey); a block's logs must agree on its hash. Integrity of the range end
// is the recorded header hash of `through` (finalized blocks only: the caller scans below its safe head).
async function scanV4(provider, fromBlock, toBlock) {
  const created = [];
  const hashes = new Map();
  const seen = new Set();
  const maxRequests = Math.ceil((toBlock - fromBlock + 1) / LOG_MAX_RANGE_BLOCKS) + 512;
  for await (const response of streamLogs(provider, V4_INITIALIZE_STREAM, fromBlock, toBlock, { maxRequests })) {
    for (const raw of response) {
      if (raw?.removed === true) throw new LogError('removed_log');
      let log;
      try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new LogError('log_outside_range', log.blockNumber);
      if (log.address !== POOL_MANAGER || log.topics[0] !== UNISWAP_EVENT_TOPICS.v4Initialize || !log.blockHash || !log.transactionHash) {
        throw new LogError('unexpected_log', log.blockNumber);
      }
      if ((hashes.get(log.blockNumber) ?? log.blockHash) !== log.blockHash) throw new LogError('log_block_hash_mismatch', log.blockNumber);
      hashes.set(log.blockNumber, log.blockHash);
      if (seen.has(`${log.blockNumber}:${log.logIndex}`)) throw new LogError('duplicate_log', log.blockNumber);
      seen.add(`${log.blockNumber}:${log.logIndex}`);
      let record;
      try { record = v4PoolRecordOf(log); } catch (error) { throw new RegistryError(error?.code ?? 'malformed_v4_initialize'); }
      created.push(record);
    }
  }
  if (new Set(created.map((pool) => pool.poolId)).size !== created.length) throw new RegistryError('duplicate_v4_initialize');
  return created.sort((left, right) => left.createdBlock - right.createdBlock || left.createdLogIndex - right.createdLogIndex);
}

// First V4 registry, [fromBlock, toBlock]. As for V3, a start after block 0 must be proven to precede the PoolManager
// deployment (no code at fromBlock - 1), so no Initialize can lie before the covered range.
export async function bootstrapV4Registry(provider, { fromBlock = 0, toBlock }) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
    throw new RegistryError('invalid_registry_range');
  }
  if (fromBlock > 0) {
    const code = await provider.request('eth_getCode', [POOL_MANAGER, hex(fromBlock - 1)]);
    if (typeof code !== 'string') throw new RegistryError('registry_start_unverified');
    if (codeIsPresent(code)) throw new RegistryError('registry_start_after_pool_manager_deployment');
  }
  const created = await scanV4(provider, fromBlock, toBlock);
  return { kind: V4_POOL_KIND, fromBlock, previousThrough: null, through: toBlock, throughHash: (await header(provider, toBlock)).hash, created };
}

export async function catchUpV4Registry(provider, coverage, toBlock) {
  if (!coverage) throw new RegistryError('v4_registry_missing');
  if (!Number.isSafeInteger(toBlock) || toBlock <= coverage.through) return null;
  if ((await header(provider, coverage.through)).hash !== coverage.throughHash) throw new RegistryError('v4_registry_fork');
  const created = await scanV4(provider, coverage.through + 1, toBlock);
  return { kind: V4_POOL_KIND, fromBlock: coverage.fromBlock, previousThrough: coverage.through, through: toBlock,
    throughHash: (await header(provider, toBlock)).hash, created };
}

// Request count of a V4 bootstrap or catch-up over [fromBlock, toBlock] without provider splits: Initialize-only chunks,
// plus the deployment proof (bootstrap after block 0) or the coverage fork check (catch-up), plus the end header.
export function v4RegistryScanRequests(fromBlock, toBlock, { bootstrap = true } = {}) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) return 0;
  const proof = bootstrap ? (fromBlock > 0 ? 1 : 0) : 1;
  return Math.ceil((toBlock - fromBlock + 1) / LOG_MAX_RANGE_BLOCKS) + proof + 1;
}

// First block with code at `address` in (low, high], by eth_getCode binary search: code must be absent at `low` and
// present at `high`, otherwise the search refuses to guess. About log2(high - low) + 2 requests.
export async function locateDeploymentBlock(provider, address, { low = 0, high }) {
  let requests = 0;
  const codeAt = async (block) => {
    requests += 1;
    const code = await provider.request('eth_getCode', [address, hex(block)]);
    if (typeof code !== 'string') throw new RegistryError('deployment_probe_unverified');
    return codeIsPresent(code);
  };
  if (!Number.isSafeInteger(low) || low < 0 || !Number.isSafeInteger(high) || high <= low) throw new RegistryError('invalid_registry_range');
  if (!(await codeAt(high))) throw new RegistryError('deployment_not_found');
  if (await codeAt(low)) throw new RegistryError('deployment_at_or_before_low');
  let absent = low;
  let present = high;
  while (present - absent > 1) {
    const middle = absent + Math.floor((present - absent) / 2);
    if (await codeAt(middle)) present = middle; else absent = middle;
  }
  return { block: present, requests, method: 'eth_getCode_binary_search' };
}
