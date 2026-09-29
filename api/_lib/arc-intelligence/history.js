import { buildBoundedSnapshot, DEFINITION_VERSION as CORE_VERSION, MAX_WINDOW_SIZE } from './core.js';
import { buildUniswapBoundedSnapshot } from './uniswap.js';
import { buildAaveV4Snapshot } from './aave.js';
import { buildMorphoV2Snapshot } from './morpho.js';
import { buildCctpV2Snapshot } from './cctp.js';
import { buildGatewaySnapshot } from './gateway.js';
import { buildDexP1Snapshot } from './dex-p1.js';
import { buildLaunchpadSnapshot } from './launchpads.js';
import { buildAcrossSnapshot } from './across.js';
import { buildP1BRegistrySnapshot } from './p1b-registry.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { quantityToSafeNumber } from './normalize.js';

export const HISTORY_DEFINITION_VERSION = 'arc-intelligence-history-v2';
export const MAX_HISTORY_BLOCKS = 500;
export const DEFAULT_CHUNK_SIZE = 25;

const DEFAULT_PROTOCOL_BUILDERS = Object.freeze({
  uniswap: buildUniswapBoundedSnapshot,
  aave: buildAaveV4Snapshot,
  morpho: buildMorphoV2Snapshot,
  cctp: buildCctpV2Snapshot,
  gateway: buildGatewaySnapshot,
  dexP1: buildDexP1Snapshot,
  launchpads: buildLaunchpadSnapshot,
  across: buildAcrossSnapshot,
  p1bRegistry: buildP1BRegistrySnapshot,
});

function tag(number) { return `0x${number.toString(16)}`; }
function hash(value) { return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null; }
function fail(message) { throw new Error(message); }

function validateInput(startBlock, endBlock, chunkSize, rpc) {
  if (rpc?.url !== ARC_RPC_URL) throw new Error('Historical indexing requires the canonical Arc public RPC.');
  if (!Number.isSafeInteger(startBlock) || !Number.isSafeInteger(endBlock)
    || startBlock < 0 || endBlock < startBlock || endBlock - startBlock + 1 > MAX_HISTORY_BLOCKS) {
    throw new RangeError(`Historical range must contain 1-${MAX_HISTORY_BLOCKS} blocks.`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_WINDOW_SIZE) {
    throw new RangeError(`chunkSize must contain 1-${MAX_WINDOW_SIZE} blocks.`);
  }
}

function validateCheckpoint(checkpoint, startBlock, endBlock) {
  if (!checkpoint) return;
  if (checkpoint.chainId !== ARC_CHAIN_ID || checkpoint.source !== ARC_RPC_URL
    || checkpoint.definitionVersion !== HISTORY_DEFINITION_VERSION
    || checkpoint.requestedStartBlock !== startBlock || checkpoint.requestedEndBlock !== endBlock
    || !Number.isSafeInteger(checkpoint.nextBlock)
    || checkpoint.nextBlock < startBlock || checkpoint.nextBlock > endBlock + 1
    || checkpoint.lastIndexedBlock !== (checkpoint.nextBlock === startBlock ? null : checkpoint.nextBlock - 1)
    || (checkpoint.lastIndexedBlock !== null && !hash(checkpoint.lastIndexedBlockHash))) {
    throw new Error('Incompatible or malformed historical checkpoint.');
  }
}

function coverageFrom(chunks, protocol, complete) {
  const results = chunks.map((chunk) => chunk.protocolSnapshots?.[protocol]).filter(Boolean);
  return {
    complete: complete && results.length === chunks.length && results.every((result) => result.complete === true
      || result.completeness?.complete === true),
    decodedChunkCount: results.length,
    definitionVersions: [...new Set(results.map((result) => result.definitionVersion).filter(Boolean))],
    warnings: [...new Set(results.flatMap((result) => result.warnings ?? []))],
    ...(protocol === 'morpho' ? {
      verifiedVaultEventScanComplete: results.length === chunks.length
        && results.every((result) => result.completeness?.verifiedVaultEventScanComplete === true),
      candidateCoverageComplete: results.length === chunks.length
        && results.every((result) => result.completeness?.candidateCoverageComplete === true),
      protocolUniverseComplete: false,
      scope: 'verified_vault_subset',
    } : {}),
    ...(protocol === 'launchpads' ? {
      verifiedFactoryEventScanComplete: results.length === chunks.length
        && results.every((result) => result.verifiedFactoryEventScanComplete === true),
      protocolUniverseComplete: results.length === chunks.length
        && results.every((result) => result.protocolUniverseComplete === true),
      scope: 'verified_launchpad_factory_subset',
    } : {}),
    ...(protocol === 'dexP1' ? { status: 'unavailable', scope: 'unverified_dex_aggregator_candidates' } : {}),
    ...(protocol === 'across' ? {
      deploymentVerified: results.length === chunks.length && results.every((result) => result.completeness?.deploymentVerified === true),
      eventScanComplete: results.length === chunks.length && results.every((result) => result.completeness?.eventScanComplete === true),
      registrySubsetComplete: results.length === chunks.length && results.every((result) => result.completeness?.registrySubsetComplete === true),
      protocolUniverseComplete: false,
      crossChainCompletionCoverage: { status: 'unavailable' },
    } : {}),
    ...(protocol === 'p1bRegistry' ? { status: 'partial', registrySubsetComplete: false, protocolUniverseComplete: false } : {}),
    ...(['cctp', 'gateway'].includes(protocol) ? { crossChainCompletionCoverage: { status: 'unavailable' } } : {}),
  };
}

// Checkpoints contain no metric data. Pass previousResult to retain prior chunks when resuming
// a full-range metric build; otherwise the result explicitly contains only newly read snapshots.
export async function buildHistoricalRange({
  rpc = createArcRpcClient(), startBlock, endBlock, chunkSize = DEFAULT_CHUNK_SIZE,
  checkpoint = null, previousResult = null, snapshotBuilder = buildBoundedSnapshot,
  protocolBuilders = DEFAULT_PROTOCOL_BUILDERS,
} = {}) {
  validateInput(startBlock, endBlock, chunkSize, rpc);
  validateCheckpoint(checkpoint, startBlock, endBlock);
  if (previousResult && !checkpoint) throw new Error('previousResult requires a matching checkpoint.');
  if (checkpoint && previousResult && (previousResult.checkpoint?.nextBlock !== checkpoint.nextBlock
    || previousResult.requestedStartBlock !== startBlock || previousResult.requestedEndBlock !== endBlock)) {
    throw new Error('Previous result does not match the resume checkpoint.');
  }
  const warnings = [];
  const priorChunks = (previousResult?.chunks ?? []).filter((chunk) => chunk.complete
    && chunk.endBlock < (checkpoint?.nextBlock ?? startBlock));
  if (previousResult) {
    const previousSnapshots = previousResult.chunkSnapshots ?? [];
    if (previousSnapshots.length !== priorChunks.length
      || priorChunks.some((chunk, index) => chunk.startBlock !== (index === 0 ? startBlock : priorChunks[index - 1].endBlock + 1)
        || previousSnapshots[index]?.complete !== true
        || previousSnapshots[index]?.startBlock !== chunk.startBlock
        || previousSnapshots[index]?.endBlock !== chunk.endBlock)
      || (priorChunks.at(-1)?.endBlock ?? startBlock - 1) !== checkpoint.nextBlock - 1
      || (priorChunks.length && hash(priorChunks.at(-1).endHash) !== hash(checkpoint.lastIndexedBlockHash))) {
      throw new Error('Previous result does not contain the complete contiguous checkpoint prefix.');
    }
  }
  const chunks = [...priorChunks];
  const chunkSnapshots = [...(previousResult?.chunkSnapshots ?? [])];
  const protocolSnapshots = [...(previousResult?.protocolSnapshots ?? [])];
  let nextBlock = checkpoint?.nextBlock ?? startBlock;
  let previousHash = checkpoint?.lastIndexedBlockHash ?? null;
  let continuityComplete = true;
  let checkpointPrefixVerified = !checkpoint || nextBlock === startBlock;
  let missingRanges = [];
  if (checkpoint && nextBlock > startBlock) {
    try {
      const priorBlock = await rpc.request('eth_getBlockByNumber', [tag(nextBlock - 1), false]);
      if (hash(priorBlock?.hash) !== hash(previousHash)) fail('Checkpoint block hash does not match canonical historical block.');
      checkpointPrefixVerified = true;
    } catch (error) {
      warnings.push(error?.message ?? 'Checkpoint block could not be verified.');
      continuityComplete = false;
      missingRanges = [{ startBlock: nextBlock, endBlock, reason: 'checkpoint_hash_unverified' }];
    }
  }
  while (continuityComplete && nextBlock <= endBlock) {
    const chunkEnd = Math.min(endBlock, nextBlock + chunkSize - 1);
    let snapshot;
    try {
      snapshot = await snapshotBuilder({ rpc, startBlock: nextBlock, endBlock: chunkEnd });
    } catch (error) {
      warnings.push(`Chunk ${nextBlock}..${chunkEnd}: ${error?.message ?? 'snapshot failed'}`);
      missingRanges.push({ startBlock: nextBlock, endBlock: chunkEnd, reason: 'snapshot_unavailable' });
      break;
    }
    const blocks = snapshot?.blocks ?? [];
    const first = blocks[0];
    const last = blocks.at(-1);
    const exactBlocks = blocks.length === chunkEnd - nextBlock + 1
      && blocks.every((block, index) => block.number === nextBlock + index);
    const boundaryMatches = previousHash === null || hash(first?.parentHash) === hash(previousHash);
    const valid = snapshot?.complete === true && snapshot.chainId === ARC_CHAIN_ID
      && snapshot.source === ARC_RPC_URL && snapshot.definitionVersion === CORE_VERSION
      && snapshot.startBlock === nextBlock && snapshot.endBlock === chunkEnd
      && snapshot.lastIndexedBlock === chunkEnd && exactBlocks
      && hash(first?.hash) !== null && hash(last?.hash) !== null && boundaryMatches;
    const summary = {
      startBlock: nextBlock, endBlock: chunkEnd, blockCount: blocks.length,
      complete: valid, lastIndexedBlock: valid ? chunkEnd : snapshot?.lastIndexedBlock ?? null,
      startHash: hash(first?.hash), endHash: hash(last?.hash),
      warnings: [...(snapshot?.warnings ?? []), ...(!boundaryMatches ? ['Chunk boundary parentHash does not match preceding chunk.'] : [])],
    };
    chunks.push(summary);
    if (!valid) {
      if (!boundaryMatches) continuityComplete = false;
      warnings.push(`Chunk ${nextBlock}..${chunkEnd} is incomplete or discontinuous.`);
      warnings.push(...summary.warnings);
      missingRanges.push({ startBlock: nextBlock, endBlock: chunkEnd, reason: boundaryMatches ? 'incomplete_chunk' : 'parent_hash_mismatch' });
      break;
    }
    chunkSnapshots.push(snapshot);
    const decoded = {};
    for (const [name, builder] of Object.entries(protocolBuilders)) {
      try {
        decoded[name] = await builder({ phase1aSnapshot: snapshot, rpc });
      } catch (error) {
        decoded[name] = { complete: false, warnings: [`${name} decoder unavailable: ${error?.message ?? 'unknown error'}`] };
      }
    }
    protocolSnapshots.push(decoded);
    summary.protocolSnapshots = decoded;
    previousHash = hash(last.hash);
    nextBlock = chunkEnd + 1;
  }
  if (nextBlock <= endBlock && !missingRanges.length) missingRanges.push({ startBlock: nextBlock, endBlock, reason: 'not_indexed' });
  if (missingRanges.length) {
    const lastGap = missingRanges.at(-1);
    if (lastGap.endBlock < endBlock) missingRanges.push({ startBlock: lastGap.endBlock + 1, endBlock, reason: 'not_indexed_after_gap' });
  }
  const contiguousEndBlock = nextBlock - 1;
  const checkpointCoverageComplete = contiguousEndBlock === endBlock && continuityComplete && checkpointPrefixVerified;
  const indexedBlocks = chunkSnapshots.reduce((count, snapshot) => count + snapshot.blockCount, 0);
  const priorIndexedBlocks = checkpoint && !previousResult ? checkpoint.nextBlock - startBlock : 0;
  const materializedCoverageComplete = checkpointCoverageComplete
    && indexedBlocks === endBlock - startBlock + 1;
  const complete = materializedCoverageComplete;
  const expectedReceipts = chunkSnapshots.reduce((count, snapshot) => count + snapshot.totalTransactions, 0);
  const observedReceipts = chunkSnapshots.reduce((count, snapshot) => count + snapshot.receiptCount, 0);
  const checkpointOut = {
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: HISTORY_DEFINITION_VERSION,
    requestedStartBlock: startBlock, requestedEndBlock: endBlock,
    lastIndexedBlock: contiguousEndBlock >= startBlock ? contiguousEndBlock : null,
    lastIndexedBlockHash: previousHash,
    nextBlock, contiguousThroughBlock: contiguousEndBlock >= startBlock ? contiguousEndBlock : null,
    complete: checkpointCoverageComplete, warnings: [...new Set(warnings)],
  };
  const protocolCoverage = Object.fromEntries(Object.keys(protocolBuilders)
    .map((name) => [name, coverageFrom(chunks.filter((chunk) => chunk.complete), name,
      materializedCoverageComplete)]));
  return {
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: HISTORY_DEFINITION_VERSION,
    requestedStartBlock: startBlock, requestedEndBlock: endBlock,
    chunks, chunkSnapshots, protocolSnapshots,
    contiguousStartBlock: startBlock, contiguousEndBlock: contiguousEndBlock >= startBlock ? contiguousEndBlock : null,
    missingRanges, continuityComplete, checkpointPrefixVerified,
    materializedCoverageComplete, checkpoint: checkpointOut,
    coreCoverage: {
      complete: materializedCoverageComplete, checkpointCoverageComplete,
      checkpointPrefixVerified, materializedCoverageComplete,
      expectedBlocks: endBlock - startBlock + 1,
      indexedBlocks,
      checkpointIndexedBlocks: indexedBlocks + priorIndexedBlocks,
      expectedReceipts: previousResult || !checkpoint ? expectedReceipts : null,
      observedReceipts: previousResult || !checkpoint ? observedReceipts : null,
      metricSnapshotCoverageComplete: materializedCoverageComplete,
    },
    protocolCoverage, complete,
    legacyUsdcCoverage: { status: 'unavailable', reason: 'Official mainnet legacy NativeCoin ABI/topic and Zero5 effective block range are not both verified.' },
    warnings: [...new Set(warnings)],
  };
}
