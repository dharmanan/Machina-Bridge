import { ARC_CHAIN_ID, ARC_RPC_URL } from './rpc.js';
import { DEFINITION_VERSION as CORE_VERSION } from './core.js';
import { HISTORY_DEFINITION_VERSION } from './history.js';
import { summarizeVerifiedAssetTransfers } from './tokens.js';
import { summarizeUsdcTransfers } from './usdc.js';
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER } from './usdc.js';

export const METRIC_DEFINITION_VERSION = 'arc-intelligence-metrics-v1';
const PERIOD_SECONDS = Object.freeze({ hour: 3600, day: 86400 });
const PROTOCOLS = ['uniswap', 'aave', 'morpho', 'cctp', 'gateway'];

function utc(seconds) { return new Date(seconds * 1000).toISOString(); }
function sumRaw(values) { return values.reduce((sum, value) => sum + BigInt(value ?? '0'), 0n).toString(10); }
function countWhere(events, predicate) { return events.filter(predicate).length; }
function position(event) { return [event.blockNumber, event.transactionIndex ?? 0, event.logIndex ?? 0]; }
function ordered(events) {
  return [...events].sort((a, b) => {
    const left = position(a); const right = position(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
}
const ZERO_ADDRESS_TOPIC = `0x${'0'.repeat(64)}`;
function rawMintBurn(logs, emitter, kind) {
  return sumRaw(logs.filter((log) => log.address?.toLowerCase() === emitter.toLowerCase()
    && log.topics?.[0] === TRANSFER_TOPIC
    && log.topics?.[kind === 'mint' ? 1 : 2] === ZERO_ADDRESS_TOPIC
    && /^0x[0-9a-f]{64}$/i.test(log.data ?? ''))
    .map((log) => BigInt(log.data)));
}

function metric({ id, value, unit = 'count', denominator = null, protocol, asset = null, scope,
  period, startUtc, endUtc, blocks, complete, sourceComplete, sourceVersions, warnings = [],
  extra = {} }) {
  const available = value !== null && value !== undefined;
  const coverageStatus = !available ? 'unavailable' : complete && sourceComplete ? 'available' : 'partial';
  return {
    metricId: id, metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, period,
    bucketStartUtc: utc(startUtc), bucketEndUtc: utc(endUtc),
    startBlock: blocks[0]?.number ?? null, endBlock: blocks.at(-1)?.number ?? null,
    lastIndexedBlock: blocks.at(-1)?.number ?? null,
    protocol, asset, scope, unit, denominator,
    value: available ? value : null,
    complete: coverageStatus === 'available', coverageStatus,
    sourceDefinitionVersions: sourceVersions, warnings: [...new Set(warnings)], ...extra,
  };
}

function eventMetric(add, id, events, { field = null, predicate = () => true, unit = 'count', asset = null, scope = 'verified_events', extra = {} } = {}) {
  const matching = events.filter(predicate);
  add(id, field ? sumRaw(matching.map((event) => event[field])) : matching.length,
    { unit: field ? unit : 'count', asset, scope, extra });
}

function emitBucket({ period, startUtc, blocks, allBlocks, snapshots, protocols, history }) {
  const endUtc = startUtc + PERIOD_SECONDS[period];
  const bucketBlocks = blocks.filter((block) => block.timestamp >= startUtc && block.timestamp < endUtc);
  if (!bucketBlocks.length) return null;
  const first = bucketBlocks[0];
  const last = bucketBlocks.at(-1);
  const firstIndex = allBlocks.findIndex((block) => block.number === first.number);
  const lastIndex = allBlocks.findIndex((block) => block.number === last.number);
  const before = allBlocks[firstIndex - 1];
  const after = allBlocks[lastIndex + 1];
  const leftBoundaryCovered = !!before && before.number === first.number - 1 && before.timestamp < startUtc;
  const rightBoundaryCovered = !!after && after.number === last.number + 1 && after.timestamp >= endUtc;
  const blockHistoryContiguous = bucketBlocks.every((block, index) => index === 0 || block.number === bucketBlocks[index - 1].number + 1);
  const coreComplete = leftBoundaryCovered && rightBoundaryCovered && blockHistoryContiguous
    && history.coreCoverage?.metricSnapshotCoverageComplete !== false;
  const bucketWarnings = [
    ...(!leftBoundaryCovered ? ['Left UTC bucket boundary is not covered by a preceding block.'] : []),
    ...(!rightBoundaryCovered ? ['Right UTC bucket boundary is not covered by a following block.'] : []),
    ...(!blockHistoryContiguous ? ['Bucket block history is not contiguous.'] : []),
  ];
  const range = (event) => Number.isSafeInteger(event.blockNumber)
    && event.blockNumber >= first.number && event.blockNumber <= last.number;
  const relevantSnapshots = snapshots.filter((snapshot) => snapshot.endBlock >= first.number && snapshot.startBlock <= last.number);
  const relevantProtocols = relevantSnapshots.map((snapshot) => protocols[snapshots.indexOf(snapshot)] ?? {});
  const sourceVersions = {
    core: CORE_VERSION, history: HISTORY_DEFINITION_VERSION, metrics: METRIC_DEFINITION_VERSION,
    ...Object.fromEntries(PROTOCOLS.map((name) => [name,
      [...new Set(relevantProtocols.map((entry) => entry[name]?.definitionVersion).filter(Boolean))]])),
  };
  const records = [];
  const add = (id, value, options = {}) => records.push(metric({
    id, value, protocol: options.protocol ?? 'arc.network', asset: options.asset ?? null,
    scope: options.scope ?? 'top_level', unit: options.unit, denominator: options.denominator ?? null,
    period, startUtc, endUtc, blocks: bucketBlocks, complete: coreComplete,
    sourceComplete: options.sourceComplete ?? true, sourceVersions,
    warnings: [...bucketWarnings, ...(options.warnings ?? [])], extra: options.extra ?? {},
  }));

  const txs = ordered(relevantSnapshots.flatMap((snapshot) => snapshot.transactions ?? []).filter(range));
  const receipts = relevantSnapshots.flatMap((snapshot) => snapshot.receipts ?? []).filter(range);
  const senderSet = new Set(txs.map((tx) => tx.from).filter(Boolean));
  const recipientSet = new Set(txs.map((tx) => tx.to).filter(Boolean));
  const activeSet = new Set([...senderSet, ...recipientSet]);
  add('network.blockCount', bucketBlocks.length);
  add('network.transactionCount', txs.length);
  add('network.successfulTransactionCount', countWhere(receipts, (receipt) => receipt.status === 'success'));
  add('network.failedTransactionCount', countWhere(receipts, (receipt) => receipt.status === 'failed'));
  add('network.totalGasUsedRaw', sumRaw(receipts.map((receipt) => receipt.gasUsedRaw)), { unit: 'raw_gas_units' });
  const feesAvailable = receipts.every((receipt) => receipt.effectiveGasPriceRaw !== null && receipt.effectiveGasPriceRaw !== undefined);
  add('network.totalTransactionFeesRaw', feesAvailable
    ? sumRaw(receipts.map((receipt) => BigInt(receipt.gasUsedRaw) * BigInt(receipt.effectiveGasPriceRaw))) : null,
  { unit: 'native_USDC_raw_units', sourceComplete: feesAvailable, warnings: feesAvailable ? [] : ['Receipt fee data is unavailable.'] });
  add('network.topLevelContractCreationCount', countWhere(receipts, (receipt) => receipt.contractAddress !== null));
  add('network.uniqueTopLevelSenders', senderSet.size);
  add('network.uniqueTopLevelRecipients', recipientSet.size);
  add('network.uniqueTopLevelActiveAddresses', activeSet.size);
  add('network.averageTransactionsPerBlock', txs.length / bucketBlocks.length,
    { unit: 'transactions_per_block', denominator: 'network.blockCount' });

  const transferLogs = ordered(relevantSnapshots.flatMap((snapshot) => snapshot.transferLogs ?? []).filter(range));
  const assetTotals = summarizeVerifiedAssetTransfers(transferLogs);
  const metadataVerified = (symbol) => relevantSnapshots.every((snapshot) =>
    snapshot.verifiedAssetObservations?.some((observation) => observation.symbol === symbol && observation.liveMetadataMatchesRegistry));
  const legacy = history.legacyUsdcCoverage?.status !== 'available';
  for (const asset of assetTotals) {
    const verified = metadataVerified(asset.symbol);
    const sourceComplete = verified && asset.complete && (asset.symbol !== 'USDC' || !legacy);
    const reasons = [
      ...(!verified ? [`${asset.symbol} metadata was not verified in every contributing chunk.`] : []),
      ...(asset.symbol === 'USDC' && legacy ? ['Historical canonical USDC coverage before Zero5 is unverified.'] : []),
    ];
    const prefix = `asset.${asset.symbol}.canonical`;
    for (const [id, value, unit] of [
      ['transferEventCount', asset.transferCount, 'count'], ['rawTransferAmount', asset.amountRaw, 'raw_asset_units'],
      ['mintEventCount', asset.mintCount, 'count'], ['burnEventCount', asset.burnCount, 'count'],
      ['mintRaw', rawMintBurn(transferLogs, asset.symbol === 'USDC' ? USDC_SYSTEM_EMITTER : asset.address, 'mint'), 'raw_asset_units'],
      ['burnRaw', rawMintBurn(transferLogs, asset.symbol === 'USDC' ? USDC_SYSTEM_EMITTER : asset.address, 'burn'), 'raw_asset_units'],
    ]) add(`${prefix}.${id}`, value, { protocol: 'asset.transfer', asset: asset.symbol,
      scope: asset.symbol === 'USDC' ? 'eip7708_explicit_transfer' : 'verified_erc20_transfer',
      unit, sourceComplete, warnings: reasons });
  }
  const interfaceActivity = summarizeUsdcTransfers(transferLogs).erc20InterfaceActivity;
  add('asset.USDC.interface.transferEventCount', interfaceActivity.transferCount,
    { protocol: 'asset.transfer', asset: 'USDC', scope: 'erc20_interface_activity_not_canonical', sourceComplete: interfaceActivity.complete && metadataVerified('USDC') });
  add('asset.USDC.interface.rawTransferAmount', interfaceActivity.amountRaw,
    { protocol: 'asset.transfer', asset: 'USDC', scope: 'erc20_interface_activity_not_canonical', unit: 'raw_erc20_interface_units', sourceComplete: interfaceActivity.complete && metadataVerified('USDC') });

  const selected = Object.fromEntries(PROTOCOLS.map((name) => [name, relevantProtocols.map((entry) => entry[name]).filter(Boolean)]));
  const protocolReady = (name, predicate) => relevantSnapshots.every((snapshot) => {
    const index = snapshots.indexOf(snapshot);
    return predicate(protocols[index]?.[name]);
  });
  const pAdd = (name, ready, id, value, options = {}) => {
    const sourceName = name === 'circle.gateway' ? 'gateway' : name.split('.')[0];
    const versions = sourceVersions[sourceName];
    const versionCompatible = versions.length === 1
      && relevantProtocols.every((entry) => entry[sourceName]?.definitionVersion === versions[0]);
    add(id, value, { ...options, protocol: name, sourceComplete: ready && versionCompatible,
      warnings: [
        ...(options.warnings ?? []),
        ...(!ready ? [`${name} decoder coverage is incomplete.`] : []),
        ...(!versionCompatible ? [`${name} definition versions are missing or mixed across contributing chunks.`] : []),
      ] });
  };

  const u = selected.uniswap;
  const v3 = ordered(u.flatMap((result) => result.v3?.rawPoolFlows ?? []).filter(range));
  const v4swap = ordered(u.flatMap((result) => result.v4?.swapEvents ?? []).filter(range));
  const v4liq = ordered(u.flatMap((result) => result.v4?.modifyLiquidityEvents ?? []).filter(range));
  const v4init = ordered(u.flatMap((result) => result.v4?.poolKeys ?? [])
    .filter((key) => Number.isSafeInteger(key.initializedAtBlock) && key.initializedAtBlock >= first.number && key.initializedAtBlock <= last.number));
  const v3ready = protocolReady('uniswap', (result) => result?.v3?.complete === true);
  const v4ready = protocolReady('uniswap', (result) => result?.v4?.eventScanComplete === true);
  for (const type of ['swap', 'mint', 'burn']) pAdd('uniswap.v3', v3ready, `uniswap.v3.verifiedPool.${type}EventCount`,
    countWhere(v3, (event) => event.type === type), { scope: 'verified_pool_subset' });
  for (const pool of new Set(v3.map((event) => event.pool).filter(Boolean))) {
    const poolEvents = v3.filter((event) => event.pool === pool);
    for (const tokenIndex of [0, 1]) {
      const token = poolEvents[0][`token${tokenIndex}`]?.address;
      if (!token) continue;
      for (const type of ['swap', 'mint', 'burn']) {
        const events = poolEvents.filter((event) => event.type === type);
        const fields = type === 'swap'
          ? [[`token${tokenIndex}InRaw`, 'inRaw'], [`token${tokenIndex}OutRaw`, 'outRaw']]
          : [[`amount${tokenIndex}Raw`, 'amountRaw']];
        for (const [field, suffix] of fields) pAdd('uniswap.v3', v3ready,
          `uniswap.v3.verifiedPool.${type}.${suffix}`, sumRaw(events.map((event) => event[field])),
          { unit: 'raw_pool_token_units', asset: token, scope: 'verified_pool_token', extra: { pool } });
      }
    }
  }
  pAdd('uniswap.v4', v4ready, 'uniswap.v4.rawPoolId.swapEventCount', v4swap.length,
    { scope: 'official_pool_manager_raw_pool_id' });
  pAdd('uniswap.v4', v4ready, 'uniswap.v4.rawPoolId.modifyLiquidityEventCount', v4liq.length,
    { scope: 'official_pool_manager_raw_pool_id' });
  pAdd('uniswap.v4', v4ready, 'uniswap.v4.initializeEventCount', v4init.length,
    { scope: 'bounded_initialize_events' });

  const a = selected.aave;
  const aFlows = ordered(a.flatMap((result) => result.rawFlows ?? []).filter(range));
  const aCollateral = ordered(a.flatMap((result) => result.collateralStateChanges ?? []).filter(range));
  const aReady = protocolReady('aave', (result) => result?.completeness?.eventsComplete === true);
  for (const type of ['supply', 'withdraw', 'borrow', 'repay', 'liquidation']) {
    pAdd('aave.v4', aReady, `aave.v4.${type}EventCount`, countWhere(aFlows, (event) => event.type === type),
      { scope: 'verified_v4_deployments' });
  }
  pAdd('aave.v4', aReady, 'aave.v4.collateralToggleEventCount', aCollateral.length,
    { scope: 'verified_v4_deployments' });
  for (const [type, field] of [['supply', 'suppliedAmountRaw'], ['withdraw', 'withdrawnAmountRaw'],
    ['borrow', 'drawnAmountRaw'], ['repay', 'totalAmountRepaidRaw']]) {
    const flow = aFlows.filter((event) => event.type === type);
    // Amounts across distinct reserve assets must never be combined.
    for (const asset of new Set(flow.map((event) => event.asset).filter(Boolean))) {
      pAdd('aave.v4', aReady, `aave.v4.${type}Raw`, sumRaw(flow.filter((event) => event.asset === asset).map((event) => event[field])),
        { unit: 'raw_underlying_asset_units', asset, scope: 'verified_v4_reserve' });
    }
  }
  for (const id of ['totalValueLocked', 'utilization', 'supplyApy', 'borrowApr', 'availableLiquidity', 'totalSupplied', 'totalBorrowed']) {
    add(`aave.v4.${id}`, null, { protocol: 'aave.v4', scope: 'accounting_unverified', warnings: ['Aave V4 accounting semantics are unavailable.'] });
  }

  const m = selected.morpho;
  const verifiedSets = relevantProtocols.map((entry) => new Set((entry.morpho?.candidates ?? [])
    .filter((candidate) => candidate.status === 'verified' && typeof candidate.address === 'string')
    .map((candidate) => candidate.address.toLowerCase())));
  const stableVerifiedVaults = [...(verifiedSets[0] ?? new Set())]
    .filter((address) => verifiedSets.every((set) => set.has(address))).sort();
  const stableVaultSet = new Set(stableVerifiedVaults);
  const mFlow = ordered(m.flatMap((result) => result.rawFlows ?? [])
    .filter((event) => range(event) && stableVaultSet.has(event.emitter?.toLowerCase())));
  const mAlloc = ordered(m.flatMap((result) => result.allocationEvents ?? [])
    .filter((event) => range(event) && stableVaultSet.has(event.emitter?.toLowerCase())));
  const mReady = stableVerifiedVaults.length > 0
    && protocolReady('morpho', (result) => result?.completeness?.verifiedVaultEventScanComplete === true);
  const mUniverse = protocolReady('morpho', (result) => result?.completeness?.candidateCoverageComplete === true);
  const mExtra = { verifiedVaults: stableVerifiedVaults,
    stableVerifiedVaultCount: stableVerifiedVaults.length, protocolUniverseComplete: mUniverse };
  for (const type of ['deposit', 'withdraw']) {
    eventMetric((id, value, options) => pAdd('morpho.v2', mReady, id, value, { ...options, extra: mExtra }),
      `morpho.v2.${type}EventCount`, mFlow, { predicate: (event) => event.type === type, scope: 'verified_vault_subset' });
    for (const field of ['assetsRaw', 'sharesRaw']) {
      // Vault identity prevents mixing distinct underlying and share units.
      for (const vault of new Set(mFlow.filter((event) => event.type === type).map((event) => event.emitter).filter(Boolean))) {
        pAdd('morpho.v2', mReady, `morpho.v2.${type}.${field}`,
          sumRaw(mFlow.filter((event) => event.type === type && event.emitter === vault).map((event) => event[field])),
          { unit: field === 'assetsRaw' ? 'raw_underlying_asset_units' : 'raw_vault_share_units',
            scope: 'verified_vault_subset', extra: { ...mExtra, vault } });
      }
    }
  }
  pAdd('morpho.v2', mReady, 'morpho.v2.allocationEventCount', mAlloc.length,
    { scope: 'verified_vault_subset', extra: mExtra });
  for (const id of ['totalValueLocked', 'utilization', 'apy', 'totalSupplied', 'totalBorrowed']) {
    add(`morpho.v2.${id}`, null, { protocol: 'morpho.v2', scope: 'accounting_unverified', extra: mExtra });
  }

  const c = selected.cctp;
  const cBurns = ordered(c.flatMap((result) => result.outboundBurns ?? []).filter(range));
  const cMints = ordered(c.flatMap((result) => result.inboundMints ?? []).filter(range));
  const cMessages = ordered(c.flatMap((result) => result.messageReceipts ?? []).filter(range));
  const cReady = protocolReady('cctp', (result) => result?.complete === true);
  for (const [id, events] of [
    ['arcOutboundBurnLegCount', cBurns], ['arcInboundMintLegCount', cMints], ['messageReceivedCount', cMessages],
  ]) pAdd('cctp.v2', cReady, `cctp.v2.${id}`, events.length, { scope: 'arc_leg_only' });
  for (const [id, events, tokenField, amountField] of [
    ['arcOutboundBurnRaw', cBurns, 'burnToken', 'amountRaw'],
    ['arcInboundMintRaw', cMints, 'mintToken', 'amountRaw'],
    ['maxFeeRaw', cBurns, 'burnToken', 'maxFeeRaw'],
    ['feeCollectedRaw', cMints, 'mintToken', 'feeCollectedRaw'],
  ]) for (const token of new Set(events.map((event) => event[tokenField]).filter(Boolean))) {
    pAdd('cctp.v2', cReady, `cctp.v2.${id}`,
      sumRaw(events.filter((event) => event[tokenField] === token).map((event) => event[amountField])),
      { scope: 'arc_leg_token', unit: 'raw_event_token_units', asset: token });
  }
  add('cctp.v2.crossChainCompletedCount', null,
    { protocol: 'cctp.v2', scope: 'counterpart_chain_unobserved' });

  const g = selected.gateway;
  const deposits = ordered(g.flatMap((result) => result.deposits ?? []).filter(range));
  const burns = ordered(g.flatMap((result) => result.burns ?? []).filter(range));
  const attestations = ordered(g.flatMap((result) => result.attestations ?? []).filter(range));
  const initiated = ordered(g.flatMap((result) => result.withdrawals?.initiated ?? []).filter(range));
  const completed = ordered(g.flatMap((result) => result.withdrawals?.completed ?? []).filter(range));
  const gReady = protocolReady('gateway', (result) => result?.complete === true);
  const gFields = [
    ['gatewayDepositCount', deposits],
    ['crossDomainSourceLegCount', burns.filter((event) => event.category === 'cross_domain_source_leg')],
    ['crossDomainDestinationLegCount', attestations.filter((event) => event.category === 'cross_domain_destination_leg')],
    ['sameDomainSourceLegCount', burns.filter((event) => event.category === 'same_domain_source_leg')],
    ['sameDomainDestinationLegCount', attestations.filter((event) => event.category === 'same_domain_destination_leg')],
    ['withdrawalInitiatedCount', initiated], ['withdrawalCompletedCount', completed],
  ];
  for (const [id, events] of gFields) pAdd('circle.gateway', gReady, `gateway.${id}`, events.length,
    { scope: 'arc_gateway_event_category' });
  for (const [id, events, field] of [
    ['gatewayDepositRaw', deposits, 'valueRaw'], ['gatewayBurnValueRaw', burns, 'valueRaw'],
    ['gatewayBurnFeeRaw', burns, 'feeRaw'], ['gatewayAttestationValueRaw', attestations, 'valueRaw'],
  ]) for (const token of new Set(events.map((event) => event.token).filter(Boolean))) {
    pAdd('circle.gateway', gReady, `gateway.${id}`,
      sumRaw(events.filter((event) => event.token === token).map((event) => event[field])),
      { scope: 'arc_gateway_token_event_category', unit: 'raw_event_token_units', asset: token });
  }
  add('gateway.crossChainCompletedCount', null,
    { protocol: 'circle.gateway', scope: 'counterpart_chain_unobserved' });

  return {
    period, bucketStartUtc: utc(startUtc), bucketEndUtc: utc(endUtc),
    startBlock: first.number, endBlock: last.number,
    leftBoundaryCovered, rightBoundaryCovered, blockHistoryContiguous,
    complete: coreComplete, coreBoundaryComplete: coreComplete,
    coverageStatus: coreComplete ? 'available' : 'partial',
    metricCount: records.length, records,
  };
}

export function createMetricAccumulator() {
  const snapshots = [];
  const protocols = [];
  let lastBlock = null;
  return {
    addChunk(snapshot, protocolSnapshots = {}) {
      if (snapshot?.complete !== true || snapshot.chainId !== ARC_CHAIN_ID
        || snapshot.source !== ARC_RPC_URL || snapshot.definitionVersion !== CORE_VERSION
        || !Array.isArray(snapshot.blocks) || !snapshot.blocks.length
        || snapshot.startBlock !== snapshot.blocks[0].number || snapshot.endBlock !== snapshot.blocks.at(-1).number) {
        throw new Error('Metric accumulator accepts only complete bounded snapshots.');
      }
      if (lastBlock !== null && (snapshot.startBlock !== lastBlock.number + 1
        || snapshot.blocks[0].parentHash?.toLowerCase() !== lastBlock.hash?.toLowerCase())) {
        throw new Error('Metric accumulator rejected duplicate, missing, or discontinuous chunk.');
      }
      if (snapshot.blocks.some((block, index) => !Number.isSafeInteger(block.timestamp)
        || block.timestamp < 0
        || (index > 0 && (block.number !== snapshot.blocks[index - 1].number + 1
          || block.parentHash?.toLowerCase() !== snapshot.blocks[index - 1].hash?.toLowerCase()
          || block.timestamp < snapshot.blocks[index - 1].timestamp)))
        || (lastBlock && snapshot.blocks[0].timestamp < lastBlock.timestamp)) {
        throw new Error('Metric accumulator rejected noncontiguous or nonmonotonic block timestamps.');
      }
      snapshots.push(snapshot);
      protocols.push(protocolSnapshots);
      lastBlock = snapshot.blocks.at(-1);
    },
    finalize(history) {
      const allBlocks = snapshots.flatMap((snapshot) => snapshot.blocks);
      const buckets = { hour: [], day: [] };
      if (!allBlocks.length) return { definitionVersion: METRIC_DEFINITION_VERSION, chainId: ARC_CHAIN_ID,
        source: ARC_RPC_URL, buckets, records: [], legacyUsdcCoverage: history?.legacyUsdcCoverage ?? { status: 'unavailable' } };
      for (const period of Object.keys(PERIOD_SECONDS)) {
        const starts = [...new Set(allBlocks.map((block) => Math.floor(block.timestamp / PERIOD_SECONDS[period]) * PERIOD_SECONDS[period]))].sort((a, b) => a - b);
        for (const startUtc of starts) buckets[period].push(emitBucket({
          period, startUtc, blocks: allBlocks, allBlocks, snapshots, protocols, history,
        }));
      }
      return {
        definitionVersion: METRIC_DEFINITION_VERSION, chainId: ARC_CHAIN_ID, source: ARC_RPC_URL,
        buckets, records: [...buckets.hour, ...buckets.day].flatMap((bucket) => bucket.records),
        legacyUsdcCoverage: history.legacyUsdcCoverage,
      };
    },
  };
}

export function buildHistoricalMetrics(history) {
  const accumulator = createMetricAccumulator();
  (history.chunkSnapshots ?? []).forEach((snapshot, index) => accumulator.addChunk(snapshot, history.protocolSnapshots?.[index]));
  return accumulator.finalize(history);
}
