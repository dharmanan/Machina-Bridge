import { mapConcurrent, verifyErc20Metadata } from './tokens.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';

export const MORPHO_V2_DEFINITION_VERSION = 'arc-intelligence-morpho-v2-v1';
export const MORPHO_V2_ARC_FACTORY = Object.freeze({
  address: '0x3b0eefaBfa22ec7CF2c73877ac16e78D76749f12',
  source: 'https://docs.morpho.org/developers/contracts/addresses/',
  sourceKey: 'Arc > Morpho Vault V2 > VaultV2Factory',
});

export const MORPHO_ARC_CANDIDATE_VAULTS = Object.freeze([
  { address: '0x8E357432CC12ff425c36432F312968aEb16112AF', candidateLabel: 'Galaxy USDC' },
  { address: '0x389abDf4355e0cF4f19298179991705a98f21c18', candidateLabel: 'Galaxy EURC' },
  { address: '0xdECcd53BE5453215821184824B519E04C7e00bC7', candidateLabel: 'Gauntlet USDC Prime' },
  { address: '0x10AF7238C6355Aa8dDB5eD60E2e9b55a72827B51', candidateLabel: 'USDC Balanced' },
  { address: '0x05863F54B05e96092069eF30c9Ca6060336e50B9', candidateLabel: 'EURC Prime' },
  { address: '0x5bEfAb92a5A3D60F578Cb51EEb4e4FD50a1e3123', candidateLabel: 'Keyrock Prime USDC' },
  { address: '0x6bdfE1165D5165808d02dE05969c9a19e9b7cf30', candidateLabel: 'Dialectic RWA USDC' },
  { address: '0x7610094B846657dCF166D59e42973db52c7015F9', candidateLabel: 'Bitwise Premium RWA USDC' },
  { address: '0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298', candidateLabel: 'Steakhouse Prime USDC' },
  { address: '0xbeef00be37BdE921BAE06fad223125BAB16c41D1', candidateLabel: 'Steakhouse EURC' },
]);

export const MORPHO_V2_EVENT_TOPICS = Object.freeze({
  deposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  withdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  allocate: '0x2bc7948a96a066968d2a58aaf46eb0b305aa166b1d1951d2f7ef0919746b8c2a',
  deallocate: '0xd602b36fb24934aef1bc2a658de029b486fa4c664a6e45de1f48e3fd1be25dd9',
  forceDeallocate: '0xb98216be0267fa550428a584fe6ac1ef0f39788e0198372100e813444afecd29',
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^[0-9a-f]{64}$/i;
const MAX_DYNAMIC_IDS = 128;
const SELECTORS = Object.freeze({
  isVaultV2: '0x5edec50d',
  asset: '0x38d52e0f',
  decimals: '0x313ce567',
  owner: '0x8da5cb5b',
  curator: '0xe66f53b7',
  adapterRegistry: '0x50b5c16a',
  adaptersLength: '0x5aa22bc8',
});

function isCode(value) {
  return typeof value === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(value);
}

function parseWord(value) {
  return typeof value === 'string' && WORD.test(value) ? BigInt(`0x${value}`) : null;
}

function parseWords(value, count) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{64})+$/i.test(value)) return null;
  const result = value.slice(2).match(/.{64}/g) ?? [];
  return result.length === count ? result : null;
}

function decodeAddressWord(value) {
  return typeof value === 'string' && /^0{24}[0-9a-f]{40}$/i.test(value)
    ? `0x${value.slice(-40)}`.toLowerCase()
    : null;
}

function encodeAddress(address) {
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function topicAddress(topic) {
  return typeof topic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(topic)
    ? `0x${topic.slice(-40)}`.toLowerCase()
    : null;
}

function decodeDynamicBytes32Array(allWords, offsetWordIndex, minimumHeadWords) {
  const offset = parseWord(allWords[offsetWordIndex]);
  if (offset === null || offset % 32n !== 0n || offset / 32n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const lengthIndex = Number(offset / 32n);
  if (lengthIndex < minimumHeadWords || lengthIndex >= allWords.length) return null;
  const length = parseWord(allWords[lengthIndex]);
  if (length === null || length > BigInt(MAX_DYNAMIC_IDS) || lengthIndex + 1 + Number(length) > allWords.length) return null;
  return allWords.slice(lengthIndex + 1, lengthIndex + 1 + Number(length)).map((value) => `0x${value.toLowerCase()}`);
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

function validEnvelope(log, topic, topicCount) {
  return log
    && ADDRESS.test(log.address ?? '')
    && Array.isArray(log.topics)
    && log.topics.length === topicCount
    && log.topics[0]?.toLowerCase() === topic
    && Number.isSafeInteger(log.blockNumber)
    && Number.isSafeInteger(log.logIndex)
    && typeof log.transactionHash === 'string'
    && /^0x[0-9a-f]{64}$/i.test(log.transactionHash)
    && typeof log.data === 'string'
    && /^0x(?:[0-9a-f]{64})*$/i.test(log.data);
}

export function decodeMorphoVaultV2Flow(log) {
  const topic = log?.topics?.[0]?.toLowerCase();
  if (topic === MORPHO_V2_EVENT_TOPICS.deposit) {
    if (!validEnvelope(log, topic, 3)) return null;
    const sender = topicAddress(log.topics[1]);
    const owner = topicAddress(log.topics[2]);
    const values = parseWords(log.data, 2);
    if (!sender || !owner || !values) return null;
    const assets = parseWord(values[0]);
    const shares = parseWord(values[1]);
    if (assets === null || shares === null) return null;
    return { ...eventBase(log, 'deposit'), sender, owner, assetsRaw: assets.toString(10), sharesRaw: shares.toString(10) };
  }
  if (topic === MORPHO_V2_EVENT_TOPICS.withdraw) {
    if (!validEnvelope(log, topic, 4)) return null;
    const sender = topicAddress(log.topics[1]);
    const receiver = topicAddress(log.topics[2]);
    const owner = topicAddress(log.topics[3]);
    const values = parseWords(log.data, 2);
    if (!sender || !receiver || !owner || !values) return null;
    const assets = parseWord(values[0]);
    const shares = parseWord(values[1]);
    if (assets === null || shares === null) return null;
    return { ...eventBase(log, 'withdraw'), sender, receiver, owner, assetsRaw: assets.toString(10), sharesRaw: shares.toString(10) };
  }
  return undefined;
}

function decodeAllocationEvent(log) {
  const topic = log?.topics?.[0]?.toLowerCase();
  const type = topic === MORPHO_V2_EVENT_TOPICS.allocate ? 'allocate'
    : topic === MORPHO_V2_EVENT_TOPICS.deallocate ? 'deallocate' : null;
  if (type === null) return undefined;
  if (!validEnvelope(log, topic, 3)) return null;
  const sender = topicAddress(log.topics[1]);
  const adapter = topicAddress(log.topics[2]);
  const allWords = log.data.slice(2).match(/.{64}/g) ?? [];
  if (!sender || !adapter || allWords.length < 3) return null;
  const assets = parseWord(allWords[0]);
  const change = parseWord(allWords[2]);
  if (assets === null || change === null) return null;
  const ids = decodeDynamicBytes32Array(allWords, 1, 3);
  if (!ids) return null;
  const signedChange = change >= (1n << 255n) ? change - (1n << 256n) : change;
  return { ...eventBase(log, type), sender, adapter, assetsRaw: assets.toString(10), ids, changeRaw: signedChange.toString(10) };
}

async function call(rpc, to, data, blockTag) {
  return rpc.request('eth_call', [{ to, data }, blockTag]);
}

async function readWord(rpc, to, data, blockTag) {
  const result = await call(rpc, to, data, blockTag);
  const values = parseWords(result, 1);
  if (!values) throw new Error('Malformed view response');
  return values[0];
}

async function verifyFactory(rpc, blockTag) {
  const address = MORPHO_V2_ARC_FACTORY.address.toLowerCase();
  let codePresent = false;
  try {
    codePresent = isCode(await rpc.request('eth_getCode', [address, blockTag]));
  } catch {
    // Keep the failure explicit in the returned status.
  }
  return { address, codePresent, source: MORPHO_V2_ARC_FACTORY.source, sourceKey: MORPHO_V2_ARC_FACTORY.sourceKey, status: codePresent ? 'code_verified' : 'unavailable' };
}

async function verifyCandidate(rpc, candidate, blockTag, factory) {
  const address = candidate.address.toLowerCase();
  let codePresent = false;
  try {
    codePresent = isCode(await rpc.request('eth_getCode', [address, blockTag]));
  } catch {
    return { ...candidate, address, status: 'unverified', version: 'unavailable', codePresent: false, underlying: null, shareToken: null, factoryEvidence: 'unavailable', verificationReason: 'code_read_unavailable' };
  }
  if (!codePresent) return {
    ...candidate,
    address,
    status: 'rejected',
    version: 'no_contract_code',
    codePresent: false,
    underlying: null,
    shareToken: null,
    factoryEvidence: 'no_code',
    rejectionEvidence: {
      authoritative: true,
      source: 'eth_getCode_at_requestedEnd',
      reason: 'no_contract_code',
      blockTag,
    },
    verificationReason: null,
  };

  let factoryRegistered = null;
  let factoryReadFailed = !factory.codePresent;
  if (factory.codePresent) {
    try {
      const result = await readWord(rpc, factory.address, `${SELECTORS.isVaultV2}${encodeAddress(address)}`, blockTag);
      const flag = parseWord(result);
      if (flag === 0n || flag === 1n) factoryRegistered = flag === 1n;
      else factoryReadFailed = true;
    } catch {
      factoryRegistered = null;
      factoryReadFailed = true;
    }
  }
  if (factoryRegistered !== true) {
    let underlying = null;
    let erc4626Interface = 'unavailable';
    try {
      const asset = decodeAddressWord(await readWord(rpc, address, SELECTORS.asset, blockTag));
      const decimals = parseWord(await readWord(rpc, address, SELECTORS.decimals, blockTag));
      if (asset && decimals !== null && decimals <= 255n) {
        erc4626Interface = 'asset_and_decimals_views_verified';
        const token = await verifyErc20Metadata(rpc, asset, { blockTag });
        underlying = {
          address: asset,
          status: token.status === 'verified' ? 'verified' : 'unavailable',
          name: token.status === 'verified' ? token.name : null,
          symbol: token.status === 'verified' ? token.symbol : null,
          decimals: token.status === 'verified' ? token.decimals : null,
        };
      }
    } catch {
      erc4626Interface = 'partial_or_unavailable';
    }
    return {
      ...candidate, address, status: 'unverified', version: 'unverified', codePresent: true,
      underlying, shareToken: null, erc4626Interface,
      factoryEvidence: factoryRegistered === false ? 'official_v2_factory_false; version_not_established' : 'official_v2_factory_unavailable',
      verificationReason: factoryRegistered === false ? 'version_not_established'
        : factoryReadFailed ? 'factory_read_unavailable'
          : underlying?.status !== 'verified' ? 'underlying_metadata_unavailable'
            : 'required_v2_view_unavailable',
    };
  }

  const viewResults = await Promise.allSettled([
    readWord(rpc, address, SELECTORS.asset, blockTag),
    readWord(rpc, address, SELECTORS.decimals, blockTag),
    readWord(rpc, address, SELECTORS.owner, blockTag),
    readWord(rpc, address, SELECTORS.curator, blockTag),
    readWord(rpc, address, SELECTORS.adapterRegistry, blockTag),
    readWord(rpc, address, SELECTORS.adaptersLength, blockTag),
  ]);
  const resultValue = (index) => viewResults[index].status === 'fulfilled' ? viewResults[index].value : null;
  const asset = decodeAddressWord(resultValue(0));
  const shareDecimalsValue = parseWord(resultValue(1));
  const owner = decodeAddressWord(resultValue(2));
  const curator = decodeAddressWord(resultValue(3));
  const adapterRegistry = decodeAddressWord(resultValue(4));
  const adaptersLength = parseWord(resultValue(5));
  const unavailableV2Views = [
    asset ? null : 'asset',
    shareDecimalsValue !== null && shareDecimalsValue <= 255n ? null : 'decimals',
    owner ? null : 'owner',
    curator ? null : 'curator',
    adapterRegistry ? null : 'adapterRegistry',
    adaptersLength === null ? 'adaptersLength' : null,
  ].filter(Boolean);
  const shareMetadata = await verifyErc20Metadata(rpc, address, { blockTag }).catch(() => null);
  const underlyingMetadata = asset ? await verifyErc20Metadata(rpc, asset, { blockTag }).catch(() => null) : null;
  const underlying = asset
    ? {
      address: asset,
      status: underlyingMetadata?.status === 'verified' ? 'verified' : 'unavailable',
      name: underlyingMetadata?.status === 'verified' ? underlyingMetadata.name : null,
      symbol: underlyingMetadata?.status === 'verified' ? underlyingMetadata.symbol : null,
      decimals: underlyingMetadata?.status === 'verified' ? underlyingMetadata.decimals : null,
    }
    : null;
  const shareDecimalsVerified = shareDecimalsValue !== null && shareDecimalsValue <= 255n;
  const shareMetadataMatches = shareMetadata?.status === 'verified' && shareMetadata.decimals === Number(shareDecimalsValue);
  const v2InterfaceVerified = unavailableV2Views.length === 0 && shareDecimalsVerified;
  const isVerified = v2InterfaceVerified && underlying?.status === 'verified';
  return {
    ...candidate,
    address,
    status: isVerified ? 'verified' : 'unverified',
    version: 'v2',
    codePresent: true,
    factoryEvidence: 'official_arc_vault_v2_factory_isVaultV2_true',
    underlying,
    shareToken: {
      name: shareMetadataMatches ? shareMetadata.name : null,
      symbol: shareMetadataMatches ? shareMetadata.symbol : null,
      decimals: shareDecimalsVerified ? Number(shareDecimalsValue) : null,
      metadataStatus: shareMetadataMatches ? 'verified' : 'partial_or_unavailable',
    },
    v2Interface: {
      status: v2InterfaceVerified ? 'verified' : 'partial',
      unavailableViews: unavailableV2Views,
      asset,
      owner,
      curator,
      adapterRegistry,
      adaptersLengthRaw: adaptersLength?.toString(10) ?? null,
    },
    verificationReason: isVerified ? null
      : unavailableV2Views.length > 0 || !shareDecimalsVerified ? 'required_v2_view_unavailable'
        : 'underlying_metadata_unavailable',
  };
}

function decodeForceDeallocate(log) {
  if (!validEnvelope(log, MORPHO_V2_EVENT_TOPICS.forceDeallocate, 3)) return null;
  const sender = topicAddress(log.topics[1]);
  const onBehalf = topicAddress(log.topics[2]);
  const allWords = log.data.slice(2).match(/.{64}/g) ?? [];
  if (!sender || !onBehalf || allWords.length < 4) return null;
  const adapter = decodeAddressWord(allWords[0]);
  const assets = parseWord(allWords[1]);
  const ids = decodeDynamicBytes32Array(allWords, 2, 4);
  const penaltyAssets = parseWord(allWords[3]);
  if (!adapter || assets === null || !ids || penaltyAssets === null) return null;
  return { ...eventBase(log, 'force_deallocate'), sender, adapter, assetsRaw: assets.toString(10), onBehalf, ids, penaltyAssetsRaw: penaltyAssets.toString(10) };
}

export function decodeMorphoVaultV2Allocation(log) {
  const topic = log?.topics?.[0]?.toLowerCase();
  if (topic === MORPHO_V2_EVENT_TOPICS.allocate || topic === MORPHO_V2_EVENT_TOPICS.deallocate) return decodeAllocationEvent(log);
  if (topic === MORPHO_V2_EVENT_TOPICS.forceDeallocate) return decodeForceDeallocate(log);
  return undefined;
}

function accountingMetrics() {
  const unavailable = { status: 'unavailable', reason: 'No independently validated Arc calculation or optional public API source is enabled.' };
  return {
    totalValueLocked: { ...unavailable },
    totalAssets: { ...unavailable },
    annualizedYield: { ...unavailable },
    apy: { ...unavailable },
    allocationBalances: { ...unavailable },
  };
}

function flowSummary(flows, allocationEvents, { verifiedVaultCount, candidateVaultCount, unresolvedCandidateCount }) {
  return {
    scope: 'verified_vault_subset',
    verifiedVaultCount,
    candidateVaultCount,
    unresolvedCandidateCount,
    depositEventCount: flows.filter((flow) => flow.type === 'deposit').length,
    withdrawEventCount: flows.filter((flow) => flow.type === 'withdraw').length,
    deposits: flows.filter((flow) => flow.type === 'deposit').map(({ emitter, assetsRaw, sharesRaw, sender, owner, blockNumber, transactionHash, logIndex }) => ({ emitter, assetsRaw, sharesRaw, sender, owner, blockNumber, transactionHash, logIndex })),
    withdrawals: flows.filter((flow) => flow.type === 'withdraw').map(({ emitter, assetsRaw, sharesRaw, sender, receiver, owner, blockNumber, transactionHash, logIndex }) => ({ emitter, assetsRaw, sharesRaw, sender, receiver, owner, blockNumber, transactionHash, logIndex })),
    allocationEventCount: allocationEvents.length,
    allocations: allocationEvents,
  };
}

export async function buildMorphoV2Snapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const warnings = [];
  const snapshotIsUsable = phase1aSnapshot?.chainId === ARC_CHAIN_ID
    && Number.isSafeInteger(phase1aSnapshot?.startBlock)
    && Number.isSafeInteger(phase1aSnapshot?.endBlock)
    && Array.isArray(phase1aSnapshot?.logs);
  const endBlock = snapshotIsUsable ? phase1aSnapshot.endBlock : null;
  const blockTag = endBlock === null ? null : `0x${endBlock.toString(16)}`;
  if (!snapshotIsUsable) warnings.push('Morpho V2 requires a Phase 1A Arc snapshot with a bounded block range and normalized logs.');
  if (phase1aSnapshot?.complete !== true) warnings.push('Phase 1A snapshot is incomplete; Morpho event completeness cannot be asserted.');

  const rpcAllowed = snapshotIsUsable && phase1aSnapshot.complete === true && rpc?.url === ARC_RPC_URL;
  const factory = rpcAllowed
    ? await verifyFactory(rpc, blockTag)
    : { address: MORPHO_V2_ARC_FACTORY.address.toLowerCase(), codePresent: false, source: MORPHO_V2_ARC_FACTORY.source, sourceKey: MORPHO_V2_ARC_FACTORY.sourceKey, status: 'unavailable' };
  if (!factory.codePresent) warnings.push('Official Morpho Arc VaultV2 factory bytecode is unavailable at requestedEnd.');

  const candidates = rpcAllowed
    ? await mapConcurrent(MORPHO_ARC_CANDIDATE_VAULTS, 2, (candidate) => verifyCandidate(rpc, candidate, blockTag, factory))
    : MORPHO_ARC_CANDIDATE_VAULTS.map((candidate) => ({
      ...candidate,
      address: candidate.address.toLowerCase(),
      status: 'unverified',
      version: 'unverified',
      codePresent: false,
      underlying: null,
      shareToken: null,
      factoryEvidence: 'verification_not_run',
    }));
  const verifiedVaults = candidates.filter((candidate) => candidate.status === 'verified');
  const verifiedAddresses = new Set(verifiedVaults.map((candidate) => candidate.address));

  const flows = [];
  const allocationEvents = [];
  let malformedEventCount = 0;
  let ignoredShareTransferCount = 0;
  if (snapshotIsUsable) {
    const candidateLogs = phase1aSnapshot.logs.filter((log) => verifiedAddresses.has(log.address?.toLowerCase()));
    for (const log of candidateLogs) {
      if (log.topics?.[0]?.toLowerCase() === MORPHO_V2_EVENT_TOPICS.transfer) {
        ignoredShareTransferCount += 1;
        continue;
      }
      const flow = decodeMorphoVaultV2Flow(log);
      if (flow === null) {
        if ([MORPHO_V2_EVENT_TOPICS.deposit, MORPHO_V2_EVENT_TOPICS.withdraw].includes(log.topics?.[0]?.toLowerCase())) malformedEventCount += 1;
        continue;
      }
      if (flow !== undefined) {
        flows.push({ ...flow, underlyingAsset: candidates.find((candidate) => candidate.address === flow.emitter)?.underlying?.address ?? null });
        continue;
      }
      const allocation = decodeMorphoVaultV2Allocation(log);
      if (allocation === null) malformedEventCount += 1;
      else if (allocation !== undefined) allocationEvents.push(allocation);
    }
  }
  if (malformedEventCount > 0) warnings.push(`${malformedEventCount} recognized Morpho VaultV2 event log(s) failed strict ABI validation.`);

  const isAuthoritativelyRejected = (candidate) => candidate.status === 'rejected'
    && candidate.rejectionEvidence?.authoritative === true;
  const unresolvedCandidateCount = candidates.filter((candidate) => candidate.status !== 'verified'
    && !isAuthoritativelyRejected(candidate)).length;
  const rejectedCandidateCount = candidates.filter(isAuthoritativelyRejected).length;
  if (unresolvedCandidateCount > 0) warnings.push(`${unresolvedCandidateCount} candidate vault(s) remain unresolved; candidate universe coverage is incomplete.`);
  if (rejectedCandidateCount > 0) warnings.push(`${rejectedCandidateCount} candidate vault(s) were authoritatively rejected at requestedEnd.`);
  const candidateCoverageComplete = candidates.length === MORPHO_ARC_CANDIDATE_VAULTS.length
    && candidates.every((candidate) => candidate.status === 'verified' || isAuthoritativelyRejected(candidate));
  const verifiedVaultEventScanComplete = snapshotIsUsable
    && phase1aSnapshot.complete === true
    && malformedEventCount === 0;
  const complete = factory.codePresent && verifiedVaultEventScanComplete && candidateCoverageComplete;
  const rawFlows = flows.map((flow) => ({
    ...flow,
    amountUnits: {
      assets: 'underlying asset raw units',
      shares: 'vault share raw units',
    },
  }));

  return {
    protocol: 'morpho.v2',
    definitionVersion: MORPHO_V2_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID,
    source: rpc?.url ?? ARC_RPC_URL,
    blockRange: snapshotIsUsable ? { startBlock: phase1aSnapshot.startBlock, endBlock, blockTag } : null,
    factory,
    candidateVaultCount: candidates.length,
    verifiedVaultCount: verifiedVaults.length,
    candidates,
    rejectedOrUnverifiedVaults: candidates.filter((candidate) => candidate.status !== 'verified').map((candidate) => ({
      address: candidate.address,
      candidateLabel: candidate.candidateLabel,
      status: candidate.status,
      version: candidate.version,
      codePresent: candidate.codePresent,
      factoryEvidence: candidate.factoryEvidence,
      rejectionEvidence: candidate.rejectionEvidence ?? null,
    })),
    flows: flowSummary(rawFlows, allocationEvents, {
      verifiedVaultCount: verifiedVaults.length,
      candidateVaultCount: candidates.length,
      unresolvedCandidateCount,
    }),
    rawFlows,
    allocationEvents,
    ignoredShareTransferCount,
    malformedEventCount,
    accountingMetrics: accountingMetrics(),
    apiReconciliation: {
      used: false,
      status: 'not_requested',
      source: null,
      apyProvenance: null,
    },
    completeness: {
      phase1aSnapshotComplete: phase1aSnapshot?.complete === true,
      factoryVerified: factory.codePresent,
      verifiedVaultEventScanComplete,
      candidateCoverageComplete,
      unresolvedCandidateCount,
      complete,
    },
    warnings: [...new Set(warnings)],
  };
}
