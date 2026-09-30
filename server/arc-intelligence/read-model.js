import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { DEFINITION_VERSION as CORE_VERSION, MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';

export const READ_MODEL_VERSION = 'arc-intelligence-read-model-v1';
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object?.[key] ?? null]));
const warnings = (values = []) => [...new Set(values)].filter((value) => typeof value === 'string')
  .slice(0, 50).map((value) => value.slice(0, 500));

const ERROR_CODES = new Set([
  'rpc_head_unavailable', 'snapshot_unavailable', 'core_incomplete', 'receipt_coverage_incomplete',
  'all_log_reconciliation_incomplete', 'transfer_log_reconciliation_incomplete',
  'checkpoint_parent_hash_mismatch', 'database_unavailable',
]);

export function sanitizedErrorCode(value) {
  if (ERROR_CODES.has(value)) return value;
  // Rows written before this correction may contain the old stable codes.
  const legacy = {
    arc_rpc_head_unavailable: 'rpc_head_unavailable',
    chunk_unavailable_or_incomplete: 'core_incomplete',
    canonical_source_mismatch: 'core_incomplete',
    intelligence_database_unavailable: 'database_unavailable',
  };
  return Object.hasOwn(legacy, value) ? legacy[value] : null;
}

export function chunkFailureCode(history, snapshot = history?.chunkSnapshots?.[0]) {
  if (history?.missingRanges?.some((range) => range.reason === 'snapshot_unavailable')) return 'snapshot_unavailable';
  if (!snapshot || (snapshot.chainId === null && snapshot.blockCount === 0)) return 'snapshot_unavailable';
  if (snapshot.source !== ARC_RPC_URL || snapshot.chainId !== ARC_CHAIN_ID) return 'core_incomplete';
  // Receipt failure makes both reconciliation sets incomplete as a consequence;
  // report it before downstream log comparisons.
  if (snapshot.allLogReconciliation?.receiptSetComplete === false
    || snapshot.transferLogReconciliation?.receiptSetComplete === false
    || (Number.isSafeInteger(snapshot.totalTransactions) && Number.isSafeInteger(snapshot.receiptCount)
      && snapshot.totalTransactions !== snapshot.receiptCount)) return 'receipt_coverage_incomplete';
  if (snapshot.allLogReconciliation?.complete === false) return 'all_log_reconciliation_incomplete';
  if (snapshot.transferLogReconciliation?.complete === false || snapshot.transferScanComplete === false) {
    return 'transfer_log_reconciliation_incomplete';
  }
  return history?.complete === true && snapshot.complete === true ? null : 'core_incomplete';
}

// Keep each emitter/market and each raw ABI field separate. No mixed assets,
// shares-to-assets conversion, USD conversion, or protocol-to-protocol totals.
function compactFlows(flows = []) {
  const groups = new Map();
  for (const flow of flows) {
    const identity = pick(flow, ['type', 'emitter', 'asset', 'reserveId', 'debtReserveId', 'collateralReserveId',
      'debtAsset', 'collateralAsset', 'burnToken', 'mintToken', 'inputToken', 'outputToken']);
    const key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { ...identity, eventCount: 0, raw: {} });
    const group = groups.get(key);
    group.eventCount += 1;
    for (const [field, value] of Object.entries(flow)) {
      if (field.endsWith('Raw')) {
        if (value === null || typeof value !== 'string' || !/^-?\d+$/.test(value)) group.raw[field] = null;
        else if (group.raw[field] !== null) group.raw[field] = (BigInt(group.raw[field] ?? '0') + BigInt(value)).toString(10);
      }
    }
  }
  return [...groups.values()];
}

function protocol(result, fields) {
  if (!result?.definitionVersion) return { status: 'unavailable', complete: false, data: null,
    warnings: warnings(result?.warnings) };
  const complete = result.complete === true || result.completeness?.complete === true;
  return { status: complete ? 'available' : 'partial', complete,
    definitionVersion: result.definitionVersion, source: result.source,
    completeness: result.completeness ?? { complete }, data: pick(result, fields), warnings: warnings(result.warnings) };
}

export function extractCompleteChunk(history, startBlock, endBlock) {
  const snapshot = history?.chunkSnapshots?.[0];
  const blocks = snapshot?.blocks ?? [];
  const first = blocks[0];
  const last = blocks.at(-1);
  const validHash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
  if (history?.complete !== true || history.continuityComplete !== true
    || history.source !== ARC_RPC_URL || history.chainId !== ARC_CHAIN_ID
    || history.requestedStartBlock !== startBlock || history.requestedEndBlock !== endBlock
    || history.chunkSnapshots.length !== 1 || snapshot?.complete !== true
    || snapshot.source !== ARC_RPC_URL || snapshot.chainId !== ARC_CHAIN_ID
    || snapshot.definitionVersion !== CORE_VERSION || snapshot.startBlock !== startBlock || snapshot.endBlock !== endBlock
    || snapshot.lastIndexedBlock !== endBlock || endBlock - startBlock + 1 > MAX_WINDOW_SIZE
    || snapshot.blockCount !== endBlock - startBlock + 1 || blocks.length !== snapshot.blockCount
    || blocks.some((block, index) => block.number !== startBlock + index || !validHash(block.hash)
      || (index > 0 && block.parentHash !== blocks[index - 1].hash))
    || !validHash(first?.parentHash) || snapshot.totalTransactions !== snapshot.receiptCount
    || !Number.isSafeInteger(snapshot.startTimestamp) || !Number.isSafeInteger(snapshot.endTimestamp)) {
    throw new Error('incomplete_chunk');
  }
  return {
    startBlock, endBlock, startHash: first.hash, endHash: last.hash, firstParentHash: first.parentHash,
    startTimestamp: snapshot.startTimestamp, endTimestamp: snapshot.endTimestamp, blockCount: snapshot.blockCount,
    transactionCount: snapshot.totalTransactions, receiptCount: snapshot.receiptCount,
    warnings: warnings([...(history.warnings ?? []), ...(snapshot.warnings ?? [])]),
  };
}

export function buildReadModel(history, chunk, generatedAt = new Date().toISOString()) {
  const core = history.chunkSnapshots[0];
  const decoded = history.protocolSnapshots[0] ?? {};
  const engineVersions = { core: core.definitionVersion, history: history.definitionVersion,
    readModel: READ_MODEL_VERSION, ...Object.fromEntries(Object.entries(decoded)
      .map(([name, result]) => [name, result.definitionVersion ?? null])) };
  const morpho = protocol(decoded.morpho, ['factory', 'candidateVaultCount', 'verifiedVaultCount', 'accountingMetrics', 'apiReconciliation']);
  if (morpho.data) {
    morpho.data.vaults = (decoded.morpho.candidates ?? []).map((vault) => pick(vault,
      ['address', 'candidateLabel', 'status', 'version', 'underlying', 'shareToken', 'factoryEvidence', 'verificationReason']));
    morpho.data.verifiedSubsetFlows = compactFlows(decoded.morpho.rawFlows);
    morpho.data.allocationEventCount = decoded.morpho.allocationEvents?.length ?? null;
    morpho.data.flowScope = 'verified_vault_subset';
  }
  const aave = protocol(decoded.aave, ['deployments', 'observedMarkets', 'eventCounts', 'accountingMetrics']);
  if (aave.data) aave.data.rawFlowsByMarket = compactFlows(decoded.aave.rawFlows);
  // Project counts and provenance only, never raw transactions/receipts/logs/events.
  const uniswap = protocol(decoded.uniswap, []);
  if (uniswap.data) {
    uniswap.data.v3 = pick(decoded.uniswap.v3, ['swapEventCount', 'poolCreatedCount', 'mintEventCount', 'burnEventCount',
      'complete', 'eventScanComplete', 'tokenMetadataComplete', 'historicalPoolRegistryComplete']);
    uniswap.data.v4 = pick(decoded.uniswap.v4, ['swapEventCount', 'initializeEventCount', 'modifyLiquidityEventCount',
      'eventScanComplete', 'poolMetadataComplete', 'tokenMetadataComplete', 'historicalPoolRegistryComplete']);
  }
  const cctp = protocol(decoded.cctp, ['contractVerification', 'eventCounts', 'arcLegEventScanComplete', 'crossChainCompletionCoverage']);
  if (cctp.data) cctp.data.rawFlowsByToken = compactFlows([...(decoded.cctp.outboundBurns ?? []), ...(decoded.cctp.inboundMints ?? [])]);
  const across = protocol(decoded.across, ['deployment', 'sourceLegCount', 'destinationLegCount', 'crossChainCompletionCoverage']);
  if (across.data) across.data.rawFlowsByToken = compactFlows([...(decoded.across.sourceLegs ?? []), ...(decoded.across.destinationLegs ?? [])]);
  const otherDex = protocol(decoded.dexP1, ['candidates', 'protocolUniverseComplete', 'eventScanComplete']);
  if (otherDex.data) otherDex.status = 'unavailable';
  const launchpads = protocol(decoded.launchpads, ['candidateFactoryCount', 'verifiedFactoryCount', 'unavailableFactoryCount',
    'verifiedFactoryEventScanComplete', 'protocolUniverseComplete', 'tokenMetadataComplete']);
  if (launchpads.data) launchpads.data.observedLaunchEventCount = decoded.launchpads.launchEvents?.length ?? null;
  return {
    definitionVersion: READ_MODEL_VERSION, generatedAt, window: 'latest_bounded_chunk',
    network: { chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, startBlock: chunk.startBlock, endBlock: chunk.endBlock,
      ...pick(core, ['blockCount', 'totalTransactions', 'receiptCount', 'successfulTransactions', 'failedTransactions',
        'uniqueTopLevelSenders', 'uniqueTopLevelRecipients', 'uniqueTopLevelActiveAddresses', 'topLevelContractCreations', 'totalGasUsedRaw']) },
    assets: { status: core.verifiedAssetObservations?.every((asset) => asset.liveMetadataMatchesRegistry) === true
        && core.verifiedAssetObservations.length > 0 ? 'available' : 'partial',
      canonicalUsdc: core.canonicalUsdc, verifiedAssetTransfers: core.verifiedAssetTransfers,
      metadata: core.verifiedAssetObservations, discovery: pick(core,
        ['discoveredTransferEmitters', 'verifiedTokenContracts', 'unverifiedTransferEmitters']) },
    dex: { uniswap, other: otherDex },
    lending: { aave, morpho },
    interop: {
      cctp,
      gateway: protocol(decoded.gateway, ['contractVerification', 'eventCounts', 'gatewayDepositRawByToken', 'arcLegEventScanComplete', 'crossChainCompletionCoverage']),
      across,
      other: protocol(decoded.p1bRegistry, ['bridgeCandidates', 'stablefxCandidates', 'rwaCandidates']),
    },
    launchpads,
    coverage: { coreRangeComplete: true, protocolCoverage: history.protocolCoverage, engineVersions,
      legacyUsdcCoverage: history.legacyUsdcCoverage, warnings: chunk.warnings,
      historicalMetrics: { status: 'unavailable', reason: 'Durable hourly and daily reduction is not implemented.' } },
    indexing: { window: 'latest_bounded_chunk', startBlock: chunk.startBlock, endBlock: chunk.endBlock,
      startHash: chunk.startHash, endHash: chunk.endHash, startTimestamp: chunk.startTimestamp, endTimestamp: chunk.endTimestamp },
  };
}

export function statusReadModel(state) {
  return { status: state?.status ?? 'starting', latestArcHead: state?.latest_arc_head ?? null,
    safeHead: state?.safe_head ?? null, lastIndexedBlock: state?.last_indexed_block ?? null,
    nextBlock: state?.next_block ?? null,
    lagBlocks: state?.safe_head !== null && state?.safe_head !== undefined && state?.last_indexed_block !== null
      && state?.last_indexed_block !== undefined ? Math.max(0, state.safe_head - state.last_indexed_block) : null,
    lastSuccess: state?.last_success_at ?? null, lastError: sanitizedErrorCode(state?.last_error) };
}
