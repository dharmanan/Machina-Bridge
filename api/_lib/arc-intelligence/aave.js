import { mapConcurrent, verifyErc20Metadata } from './tokens.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';

export const AAVE_V4_DEFINITION_VERSION = 'arc-intelligence-aave-v4-v1';

export const AAVE_V4_DEPLOYMENTS = Object.freeze({
  coreHub: Object.freeze({ address: '0x17288dfc86205301064577b98B02b81017e6F79C', role: 'core_hub' }),
  mainSpoke: Object.freeze({ address: '0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d', role: 'main_spoke' }),
  forexSpoke: Object.freeze({ address: '0x4164EBCAF74670aa74C8D4F59de6157c0780F1bB', role: 'forex_spoke' }),
});

export const AAVE_V4_EVENT_TOPICS = Object.freeze({
  supply: '0xd986db228cb1fe8392c5f45ff5f2c639b7db6cbd9ca7d1fe70b2de90c2c8c961',
  withdraw: '0xfe7813e2866053d5c3938554e517b554fce6666a6561bed9eaa7419b29fa9b68',
  borrow: '0xef18174796a5d2f91d51dc5e907a4d7867bbd6e800f6225168e0453d581d0dcd',
  repay: '0xd765a0263e8a360da8dd4fdb8c0dc5553adec12a96f29a462cdb45e5bea407dd',
  liquidationCall: '0x2a1f12d996f530f89d8038aa293f9fde81cac44b6dfd6225e3358d09b78a4a37',
  setUsingAsCollateral: '0x4763df430bc5274807f8ab4ce0734e7898513638418d6eec0c5285ef85f7f51f',
  addReserve: '0xb2d3221c3db1eb0d586556ae23399acdfe3e52ff0fcd184c19069c730f9ca2e9',
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^[0-9a-f]{64}$/i;
const SELECTORS = Object.freeze({
  hubAssetCount: '0xa0aead4d',
  hubAsset: '0xeac8f5b8',
  spokeReserveCount: '0x99806546',
  spokeReserve: '0x77778db3',
});
const MAX_DISCOVERY_ITEMS = 64;

function word(value) {
  if (typeof value !== 'string' || !WORD.test(value)) return null;
  return BigInt(`0x${value}`);
}

function words(data, count) {
  if (count === 0) return data === '0x' ? [] : null;
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{64})+$/i.test(data)) return null;
  const result = data.slice(2).match(/.{64}/g) ?? [];
  return result.length === count ? result : null;
}

function decodeAddressWord(value) {
  if (!WORD.test(value) || !/^0{24}[0-9a-f]{40}$/i.test(value)) return null;
  return `0x${value.slice(-40)}`.toLowerCase();
}

function decodeTopicAddress(value) {
  return typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value)
    ? `0x${value.slice(-40)}`.toLowerCase()
    : null;
}

function decodeTopicUint(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
    ? BigInt(value).toString(10)
    : null;
}

function addressCall(to, selector, address) {
  return { to, data: `${selector}${address.slice(2).toLowerCase().padStart(64, '0')}` };
}

function uintCall(to, selector, value) {
  return { to, data: `${selector}${BigInt(value).toString(16).padStart(64, '0')}` };
}

async function readUintCall(rpc, to, data, tag) {
  const result = await rpc.request('eth_call', [{ to, data }, tag]);
  const parsed = words(result, 1);
  if (!parsed) throw new Error('Malformed uint view response');
  return BigInt(`0x${parsed[0]}`);
}

function decodeAsset(data, assetId) {
  const values = words(data, 17);
  if (!values) return null;
  const underlying = decodeAddressWord(values[12]);
  const decimals = word(values[2]);
  if (!underlying || underlying === '0x0000000000000000000000000000000000000000' || decimals === null || decimals > 255n) return null;
  return { assetId: String(assetId), underlying, decimals: Number(decimals) };
}

function decodeReserve(data, reserveId) {
  const values = words(data, 7);
  if (!values) return null;
  const underlying = decodeAddressWord(values[0]);
  const hub = decodeAddressWord(values[1]);
  const assetId = word(values[2]);
  const decimals = word(values[3]);
  const collateralRisk = word(values[4]);
  const flags = word(values[5]);
  const dynamicConfigKey = word(values[6]);
  if (!underlying || !hub || assetId === null || assetId > 65535n || decimals === null || decimals > 255n
    || collateralRisk === null || collateralRisk >= (1n << 24n) || flags === null || flags > 255n
    || dynamicConfigKey === null || dynamicConfigKey >= (1n << 32n)) return null;
  return {
    reserveId: String(reserveId),
    underlying,
    hub,
    assetId: assetId.toString(10),
    decimals: Number(decimals),
    collateralRiskRaw: collateralRisk.toString(10),
    flagsRaw: flags.toString(10),
    dynamicConfigKeyRaw: dynamicConfigKey.toString(10),
  };
}

function validEventEnvelope(log, topic, topicCount, dataWordCount) {
  return log
    && ADDRESS.test(log.address ?? '')
    && Array.isArray(log.topics)
    && log.topics.length === topicCount
    && log.topics[0]?.toLowerCase() === topic
    && Number.isSafeInteger(log.blockNumber)
    && Number.isSafeInteger(log.logIndex)
    && typeof log.transactionHash === 'string'
    && /^0x[0-9a-f]{64}$/i.test(log.transactionHash)
    && words(log.data, dataWordCount) !== null;
}

function eventBase(log, type) {
  return {
    type,
    blockNumber: log.blockNumber,
    transactionIndex: Number.isSafeInteger(log.transactionIndex) ? log.transactionIndex : null,
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    emitter: log.address.toLowerCase(),
  };
}

function decodePositionFlow(log, type, topic) {
  if (!validEventEnvelope(log, topic, 4, 2)) return null;
  const reserveId = decodeTopicUint(log.topics[1]);
  const caller = decodeTopicAddress(log.topics[2]);
  const positionOwner = decodeTopicAddress(log.topics[3]);
  const data = words(log.data, 2);
  if (reserveId === null || !caller || !positionOwner) return null;
  const sharesRaw = word(data[0]);
  const amountRaw = word(data[1]);
  if (sharesRaw === null || amountRaw === null) return null;
  const flow = { ...eventBase(log, type), reserveId, caller, positionOwner };
  if (type === 'supply') {
    flow.suppliedSharesRaw = sharesRaw.toString(10);
    flow.suppliedAmountRaw = amountRaw.toString(10);
  } else if (type === 'withdraw') {
    flow.withdrawnSharesRaw = sharesRaw.toString(10);
    flow.withdrawnAmountRaw = amountRaw.toString(10);
  } else {
    flow.drawnSharesRaw = sharesRaw.toString(10);
    flow.drawnAmountRaw = amountRaw.toString(10);
  }
  return flow;
}

function decodePremiumDelta(values, index) {
  const sharesDelta = word(values[index]);
  const offsetDelta = word(values[index + 1]);
  const restoredPremium = word(values[index + 2]);
  if (sharesDelta === null || offsetDelta === null || restoredPremium === null) return null;
  const toSigned = (value) => value >= (1n << 255n) ? value - (1n << 256n) : value;
  return {
    sharesDeltaRaw: toSigned(sharesDelta).toString(10),
    offsetRayDeltaRaw: toSigned(offsetDelta).toString(10),
    restoredPremiumRayRaw: restoredPremium.toString(10),
  };
}

function decodeRepay(log) {
  if (!validEventEnvelope(log, AAVE_V4_EVENT_TOPICS.repay, 4, 5)) return null;
  const reserveId = decodeTopicUint(log.topics[1]);
  const caller = decodeTopicAddress(log.topics[2]);
  const positionOwner = decodeTopicAddress(log.topics[3]);
  const data = words(log.data, 5);
  if (reserveId === null || !caller || !positionOwner) return null;
  const sharesRaw = word(data[0]);
  const amountRaw = word(data[1]);
  const premiumDelta = decodePremiumDelta(data, 2);
  if (sharesRaw === null || amountRaw === null || !premiumDelta) return null;
  return { ...eventBase(log, 'repay'), reserveId, caller, positionOwner, drawnSharesRaw: sharesRaw.toString(10), totalAmountRepaidRaw: amountRaw.toString(10), premiumDelta };
}

function decodeLiquidation(log) {
  if (!validEventEnvelope(log, AAVE_V4_EVENT_TOPICS.liquidationCall, 4, 10)) return null;
  const collateralReserveId = decodeTopicUint(log.topics[1]);
  const debtReserveId = decodeTopicUint(log.topics[2]);
  const positionOwner = decodeTopicAddress(log.topics[3]);
  const data = words(log.data, 10);
  const liquidator = decodeAddressWord(data[0]);
  const receiveShares = word(data[1]);
  const debtAmountRestored = word(data[2]);
  const drawnSharesLiquidated = word(data[3]);
  const premiumDelta = decodePremiumDelta(data, 4);
  const collateralAmountRemoved = word(data[7]);
  const collateralSharesLiquidated = word(data[8]);
  const collateralSharesToLiquidator = word(data[9]);
  if (collateralReserveId === null || debtReserveId === null || !positionOwner || !liquidator
    || receiveShares === null || receiveShares > 1n || debtAmountRestored === null || drawnSharesLiquidated === null
    || !premiumDelta || collateralAmountRemoved === null || collateralSharesLiquidated === null || collateralSharesToLiquidator === null) return null;
  return {
    ...eventBase(log, 'liquidation'), collateralReserveId, debtReserveId, positionOwner, liquidator,
    receiveShares: receiveShares === 1n,
    debtAmountRestoredRaw: debtAmountRestored.toString(10),
    drawnSharesLiquidatedRaw: drawnSharesLiquidated.toString(10),
    premiumDelta,
    collateralAmountRemovedRaw: collateralAmountRemoved.toString(10),
    collateralSharesLiquidatedRaw: collateralSharesLiquidated.toString(10),
    collateralSharesToLiquidatorRaw: collateralSharesToLiquidator.toString(10),
  };
}

function decodeCollateralToggle(log) {
  if (!validEventEnvelope(log, AAVE_V4_EVENT_TOPICS.setUsingAsCollateral, 4, 1)) return null;
  const reserveId = decodeTopicUint(log.topics[1]);
  const caller = decodeTopicAddress(log.topics[2]);
  const positionOwner = decodeTopicAddress(log.topics[3]);
  const enabled = word(words(log.data, 1)[0]);
  if (reserveId === null || !caller || !positionOwner || enabled === null || enabled > 1n) return null;
  return { ...eventBase(log, 'set_using_as_collateral'), reserveId, caller, positionOwner, usingAsCollateral: enabled === 1n };
}

function decodeAddReserve(log) {
  if (!validEventEnvelope(log, AAVE_V4_EVENT_TOPICS.addReserve, 4, 0)) return null;
  const reserveId = decodeTopicUint(log.topics[1]);
  const assetId = decodeTopicUint(log.topics[2]);
  const hub = decodeTopicAddress(log.topics[3]);
  if (reserveId === null || assetId === null || !hub) return null;
  return { ...eventBase(log, 'add_reserve'), reserveId, assetId, hub };
}

export function decodeAaveV4Event(log) {
  const topic = log?.topics?.[0]?.toLowerCase();
  switch (topic) {
    case AAVE_V4_EVENT_TOPICS.supply: return decodePositionFlow(log, 'supply', topic);
    case AAVE_V4_EVENT_TOPICS.withdraw: return decodePositionFlow(log, 'withdraw', topic);
    case AAVE_V4_EVENT_TOPICS.borrow: return decodePositionFlow(log, 'borrow', topic);
    case AAVE_V4_EVENT_TOPICS.repay: return decodeRepay(log);
    case AAVE_V4_EVENT_TOPICS.liquidationCall: return decodeLiquidation(log);
    case AAVE_V4_EVENT_TOPICS.setUsingAsCollateral: return decodeCollateralToggle(log);
    case AAVE_V4_EVENT_TOPICS.addReserve: return decodeAddReserve(log);
    default: return undefined;
  }
}

function toBlockTag(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

function blankEventCounts() {
  return { supply: 0, withdraw: 0, borrow: 0, repay: 0, liquidation: 0, setUsingAsCollateral: 0, addReserve: 0 };
}

function unavailableMetrics() {
  const unavailable = { status: 'unavailable', reason: 'Accounting semantics are not implemented or independently validated.' };
  return {
    totalValueLocked: { ...unavailable },
    utilization: { ...unavailable },
    supplyApy: { ...unavailable },
    borrowApr: { ...unavailable },
    availableLiquidity: { ...unavailable },
    totalSupplied: { ...unavailable },
    totalBorrowed: { ...unavailable },
  };
}

async function verifyHub(rpc, blockTag) {
  const address = AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase();
  const code = await rpc.request('eth_getCode', [address, blockTag]);
  const codePresent = typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code);
  if (!codePresent) return { address, codePresent: false, status: 'unverified', assetCount: null, assets: [], warnings: ['Core Hub bytecode is absent at requestedEnd.'] };

  try {
    const count = await readUintCall(rpc, address, SELECTORS.hubAssetCount, blockTag);
    if (count > BigInt(MAX_DISCOVERY_ITEMS)) return { address, codePresent: true, status: 'unverified', assetCount: count.toString(10), assets: [], warnings: ['Core Hub asset enumeration exceeded the bounded validation limit.'] };
    const indices = Array.from({ length: Number(count) }, (_, index) => index);
    const assets = await mapConcurrent(indices, 4, async (assetId) => {
      const raw = await rpc.request('eth_call', [uintCall(address, SELECTORS.hubAsset, assetId), blockTag]);
      const asset = decodeAsset(raw, assetId);
      return asset ? { ...asset, status: 'view_verified' } : null;
    });
    const complete = assets.length === Number(count) && assets.every(Boolean);
    return {
      address,
      codePresent: true,
      status: complete ? 'view_verified' : 'partial',
      assetCount: count.toString(10),
      assets: assets.filter(Boolean),
      warnings: complete ? [] : ['One or more Core Hub getAsset views did not decode as the official Asset struct.'],
    };
  } catch {
    return { address, codePresent: true, status: 'partial', assetCount: null, assets: [], warnings: ['Core Hub official view validation failed at requestedEnd.'] };
  }
}

async function verifySpoke(rpc, deployment, hub, blockTag) {
  const address = deployment.address.toLowerCase();
  const code = await rpc.request('eth_getCode', [address, blockTag]);
  const codePresent = typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code);
  if (!codePresent) return { role: deployment.role, address, codePresent: false, status: 'unverified', reserveCount: null, reserves: [], warnings: ['Spoke bytecode is absent at requestedEnd.'] };

  try {
    const count = await readUintCall(rpc, address, SELECTORS.spokeReserveCount, blockTag);
    if (count > BigInt(MAX_DISCOVERY_ITEMS)) return { role: deployment.role, address, codePresent: true, status: 'unverified', reserveCount: count.toString(10), reserves: [], warnings: ['Spoke reserve enumeration exceeded the bounded validation limit.'] };

    // Probe count + 1 IDs so both zero-based and one-based deployed numbering can be
    // observed, then require exactly the count of valid official Reserve structs.
    const ids = Array.from({ length: Number(count) + 1 }, (_, index) => index);
    const probed = await mapConcurrent(ids, 4, async (reserveId) => {
      try {
        const raw = await rpc.request('eth_call', [uintCall(address, SELECTORS.spokeReserve, reserveId), blockTag]);
        return decodeReserve(raw, reserveId);
      } catch {
        return null;
      }
    });
    const reserves = probed.filter(Boolean);
    const assetById = new Map(hub.assets.map((asset) => [asset.assetId, asset]));
    const linkedReserves = reserves.map((reserve) => {
      const asset = assetById.get(reserve.assetId);
      return {
        ...reserve,
        hubMatchesCore: reserve.hub === hub.address,
        underlyingMatchesHubAsset: asset?.underlying === reserve.underlying,
        decimalsMatchHubAsset: asset?.decimals === reserve.decimals,
      };
    });
    const reserveSetVerified = count === 0n
      ? false
      : BigInt(reserves.length) === count
        && linkedReserves.length === reserves.length
        && linkedReserves.every((reserve) => reserve.hubMatchesCore && reserve.underlyingMatchesHubAsset && reserve.decimalsMatchHubAsset);
    return {
      role: deployment.role,
      address,
      codePresent: true,
      status: reserveSetVerified ? 'view_verified' : 'partial',
      reserveCount: count.toString(10),
      reserves: linkedReserves,
      warnings: reserveSetVerified ? [] : ['Spoke reserves did not fully link to matching Core Hub assets at requestedEnd.'],
    };
  } catch {
    return { role: deployment.role, address, codePresent: true, status: 'partial', reserveCount: null, reserves: [], warnings: ['Spoke official view validation failed at requestedEnd.'] };
  }
}

function eventCountsFrom(events) {
  const counts = blankEventCounts();
  for (const event of events) {
    if (event.type === 'set_using_as_collateral') counts.setUsingAsCollateral += 1;
    else if (event.type === 'add_reserve') counts.addReserve += 1;
    else if (Object.hasOwn(counts, event.type)) counts[event.type] += 1;
  }
  return counts;
}

export async function buildAaveV4Snapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const warnings = [];
  const snapshotIsUsable = phase1aSnapshot?.chainId === ARC_CHAIN_ID
    && Number.isSafeInteger(phase1aSnapshot?.startBlock)
    && Number.isSafeInteger(phase1aSnapshot?.endBlock)
    && Array.isArray(phase1aSnapshot?.logs);
  const endBlock = snapshotIsUsable ? phase1aSnapshot.endBlock : null;
  const blockTag = endBlock === null ? null : toBlockTag(endBlock);
  if (!snapshotIsUsable) warnings.push('Aave V4 requires a Phase 1A Arc snapshot with a bounded block range and normalized logs.');
  if (phase1aSnapshot?.complete !== true) warnings.push('Phase 1A snapshot is incomplete; Aave event completeness cannot be asserted.');

  let hub = { address: AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase(), status: 'unverified', codePresent: false, assetCount: null, assets: [], warnings: [] };
  let spokes = [];
  if (snapshotIsUsable && phase1aSnapshot.complete === true && rpc?.url === ARC_RPC_URL) {
    hub = await verifyHub(rpc, blockTag);
    spokes = await Promise.all([AAVE_V4_DEPLOYMENTS.mainSpoke, AAVE_V4_DEPLOYMENTS.forexSpoke]
      .map((deployment) => verifySpoke(rpc, deployment, hub, blockTag)));
  } else {
    if (rpc?.url !== ARC_RPC_URL) warnings.push('Canonical verification requires the exact Arc public RPC endpoint.');
    spokes = [AAVE_V4_DEPLOYMENTS.mainSpoke, AAVE_V4_DEPLOYMENTS.forexSpoke].map((deployment) => ({
      role: deployment.role, address: deployment.address.toLowerCase(), codePresent: false, status: 'unverified', reserveCount: null, reserves: [], warnings: [],
    }));
  }
  warnings.push(...hub.warnings, ...spokes.flatMap((spoke) => spoke.warnings));

  const verifiedEmitters = new Set(spokes.filter((spoke) => spoke.status === 'view_verified').map((spoke) => spoke.address));
  const relevantLogs = snapshotIsUsable
    ? phase1aSnapshot.logs.filter((log) => verifiedEmitters.has(log.address?.toLowerCase()) && Object.values(AAVE_V4_EVENT_TOPICS).includes(log.topics?.[0]?.toLowerCase()))
    : [];
  const events = [];
  let malformedEventCount = 0;
  for (const log of relevantLogs) {
    const decoded = decodeAaveV4Event(log);
    if (decoded === undefined) continue;
    if (decoded === null) malformedEventCount += 1;
    else events.push(decoded);
  }
  if (malformedEventCount > 0) warnings.push(`${malformedEventCount} recognized Aave V4 event log(s) failed strict ABI validation.`);

  const reserveBySpokeAndId = new Map(spokes.flatMap((spoke) => spoke.reserves.map((reserve) => [`${spoke.address}:${reserve.reserveId}`, reserve])));
  const requiredReserveKeys = new Set();
  for (const event of events) {
    if (event.reserveId !== undefined) requiredReserveKeys.add(`${event.emitter}:${event.reserveId}`);
    if (event.collateralReserveId !== undefined) requiredReserveKeys.add(`${event.emitter}:${event.collateralReserveId}`);
    if (event.debtReserveId !== undefined) requiredReserveKeys.add(`${event.emitter}:${event.debtReserveId}`);
    if (event.type === 'add_reserve') requiredReserveKeys.add(`${event.emitter}:${event.reserveId}`);
  }
  const missingEventReserves = [...requiredReserveKeys].filter((key) => !reserveBySpokeAndId.has(key));
  if (missingEventReserves.length > 0) warnings.push(`${missingEventReserves.length} observed reserve ID(s) were not resolved to the official Spoke Reserve struct.`);

  const reserveItems = [...reserveBySpokeAndId.entries()];
  const metadata = snapshotIsUsable && rpc?.url === ARC_RPC_URL
    ? await mapConcurrent([...new Set(reserveItems.map(([, reserve]) => reserve.underlying))], 3, (address) => verifyErc20Metadata(rpc, address, { blockTag }))
    : [];
  const metadataByAddress = new Map(metadata.map((item) => [item.address, item]));
  const observedMarkets = reserveItems.map(([key, reserve]) => {
    const [spoke] = key.split(':');
    const token = metadataByAddress.get(reserve.underlying);
    return {
      protocol: 'aave.v4',
      spoke,
      reserveId: reserve.reserveId,
      hub: reserve.hub,
      assetId: reserve.assetId,
      underlying: reserve.underlying,
      assetDecimals: token?.status === 'verified' && token.decimals === reserve.decimals ? token.decimals : null,
      assetMetadataStatus: token?.status === 'verified' && token.decimals === reserve.decimals ? 'verified' : 'unavailable',
      collateralRiskRaw: reserve.collateralRiskRaw,
      reserveFlagsRaw: reserve.flagsRaw,
      dynamicConfigKeyRaw: reserve.dynamicConfigKeyRaw,
      identityStatus: reserve.hubMatchesCore && reserve.underlyingMatchesHubAsset && reserve.decimalsMatchHubAsset ? 'verified' : 'unverified',
    };
  });
  const marketByKey = new Map(observedMarkets.map((market) => [`${market.spoke}:${market.reserveId}`, market]));
  const rawFlows = events.filter((event) => ['supply', 'withdraw', 'borrow', 'repay', 'liquidation'].includes(event.type))
    .map((event) => {
      if (event.type === 'liquidation') {
        return {
          ...event,
          debtAsset: marketByKey.get(`${event.emitter}:${event.debtReserveId}`)?.underlying ?? null,
          collateralAsset: marketByKey.get(`${event.emitter}:${event.collateralReserveId}`)?.underlying ?? null,
          amountUnit: 'raw underlying asset units as defined by the event ABI',
        };
      }
      return {
        ...event,
        asset: marketByKey.get(`${event.emitter}:${event.reserveId}`)?.underlying ?? null,
        amountUnit: 'raw underlying asset units as defined by the event ABI',
      };
    });
  const deploymentVerified = hub.status === 'view_verified'
    && spokes.length === 2
    && spokes.every((spoke) => spoke.status === 'view_verified');
  const eventDataComplete = snapshotIsUsable && phase1aSnapshot.complete === true && deploymentVerified
    && malformedEventCount === 0 && missingEventReserves.length === 0;

  return {
    protocol: 'aave.v4',
    definitionVersion: AAVE_V4_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID,
    source: rpc?.url ?? ARC_RPC_URL,
    blockRange: snapshotIsUsable ? { startBlock: phase1aSnapshot.startBlock, endBlock, blockTag } : null,
    deployments: [hub, ...spokes],
    observedMarkets,
    eventCounts: eventCountsFrom(events),
    malformedEventCount,
    rawFlows,
    collateralStateChanges: events.filter((event) => event.type === 'set_using_as_collateral'),
    allocationEvents: [],
    accountingMetrics: unavailableMetrics(),
    apiReconciliation: { used: false, status: 'not_requested', provenance: null },
    completeness: {
      phase1aSnapshotComplete: phase1aSnapshot?.complete === true,
      deploymentsVerified: deploymentVerified,
      observedReservesResolved: missingEventReserves.length === 0,
      eventsComplete: eventDataComplete,
      complete: eventDataComplete,
    },
    warnings: [...new Set(warnings)],
  };
}
