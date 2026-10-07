import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { P1A_LAUNCHPAD_CANDIDATES } from './p1a-registry.js';
import { decodeOfficialEvent, eventIdentity, eventTopic, snapshotContext } from './circle-common.js';
import { mapConcurrent, verifyErc20Metadata } from './tokens.js';
import { ARGUS_ADAPTER } from './launchpad-adapters/argus.js';
import { TOLLY_ADAPTER } from './launchpad-adapters/tolly.js';
import { OPENLAUNCH_ADAPTER } from './launchpad-adapters/openlaunch.js';
import { ARCHEMIST_V2_ADAPTER } from './launchpad-adapters/archemist-v2.js';
import { LAUNCHPADS_DEFINITION_VERSION, verifyFactory } from './launchpad-adapters/common.js';

export { LAUNCHPADS_DEFINITION_VERSION, verifyFactory };
export const MAX_LAUNCHPAD_TOKEN_METADATA = 25;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const NONZERO_ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/i;
const ADAPTERS = new Map([ARGUS_ADAPTER, TOLLY_ADAPTER, OPENLAUNCH_ADAPTER, ARCHEMIST_V2_ADAPTER]
  .map((adapter) => [adapter.protocol, adapter]));

export function decodeVerifiedLaunch(log, candidate, adapter) {
  if (log?.address?.toLowerCase() !== candidate.address) return undefined;
  const args = decodeOfficialEvent(log, adapter.abi);
  if (args === undefined || args === null) return args;
  try {
    if (!NONZERO_ADDRESS.test(args.token ?? '')) return null;
    const creator = adapter.creatorField ? args[adapter.creatorField] : null;
    if (creator !== null && !ADDRESS.test(creator ?? '')) return null;
    return {
      ...eventIdentity(log, 'launch'), protocol: candidate.protocol, version: candidate.version,
      token: args.token.toLowerCase(), creator: creator?.toLowerCase() ?? null,
      ...adapter.project(args),
    };
  } catch {
    return null;
  }
}

export async function buildLaunchpadSnapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  const rpcAllowed = context.complete && rpc?.url === ARC_RPC_URL;
  const warnings = [];
  if (!context.complete) warnings.push('Complete Phase 1A Arc receipt/log snapshot unavailable.');
  if (rpc?.url !== ARC_RPC_URL) warnings.push('Canonical Arc public RPC is required for factory verification.');
  const factories = await mapConcurrent(P1A_LAUNCHPAD_CANDIDATES, 3, async (candidate) => {
    const adapter = ADAPTERS.get(candidate.protocol);
    if (!rpcAllowed || !adapter || candidate.verificationStatus !== 'source_verified_candidate') {
      return { ...candidate, status: 'unavailable', codePresent: null, eventTopic: adapter ? eventTopic(adapter.abi) : null,
        eventTopicInBytecode: false, viewResult: null, viewVerified: false,
        eventScanComplete: false, malformedEventCount: 0,
        verificationReason: !adapter ? 'official_arc_abi_or_deployment_unverified' : 'core_or_rpc_unavailable' };
    }
    return verifyFactory(candidate, adapter, rpc, context.blockRange.blockTag);
  });
  const timestampByBlock = new Map((phase1aSnapshot?.blocks ?? []).map((block) => [block.number, block.timestamp]));
  const launchEvents = [];
  for (const factory of factories) {
    if (factory.status !== 'verified') continue;
    const adapter = ADAPTERS.get(factory.protocol);
    for (const log of phase1aSnapshot.logs) {
      const decoded = decodeVerifiedLaunch(log, factory, adapter);
      if (decoded === undefined) continue;
      if (decoded === null) factory.malformedEventCount += 1;
      else launchEvents.push({ ...decoded, launchTimestamp: timestampByBlock.get(decoded.blockNumber) ?? null });
    }
    factory.eventScanComplete = context.complete && factory.malformedEventCount === 0;
    if (factory.malformedEventCount) warnings.push(`${factory.protocol}: ${factory.malformedEventCount} recognized launch event(s) failed strict ABI decoding.`);
  }
  launchEvents.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  const uniqueTokens = [...new Set(launchEvents.map((event) => event.token))].sort();
  const selectedTokens = uniqueTokens.slice(0, MAX_LAUNCHPAD_TOKEN_METADATA);
  const tokenMetadata = rpcAllowed
    ? await mapConcurrent(selectedTokens, 3, (address) => verifyErc20Metadata(rpc, address,
      { blockTag: context.blockRange.blockTag })) : [];
  const tokenMetadataComplete = uniqueTokens.length === selectedTokens.length
    && tokenMetadata.every((record) => record.status === 'verified');
  if (!tokenMetadataComplete) warnings.push('Some launched token metadata is unverified or exceeded the bounded metadata limit.');
  const verifiedFactories = factories.filter((factory) => factory.status === 'verified');
  const verifiedFactoryEventScanComplete = context.complete && verifiedFactories.length > 0
    && verifiedFactories.every((factory) => factory.eventScanComplete);
  const protocolUniverseComplete = factories.every((factory) => factory.status === 'verified');
  if (!protocolUniverseComplete) warnings.push('Launchpad candidate universe remains incomplete; counts cover verified factory emitters only.');
  return {
    protocol: 'launchpad.p1', definitionVersion: LAUNCHPADS_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID, source: rpc?.url ?? ARC_RPC_URL,
    blockRange: context.blockRange, candidateFactoryCount: factories.length,
    verifiedFactoryCount: verifiedFactories.length,
    unavailableFactoryCount: factories.length - verifiedFactories.length,
    factories, launchEvents, tokenMetadata,
    tokenMetadataComplete, verifiedFactoryEventScanComplete,
    protocolUniverseComplete,
    complete: verifiedFactoryEventScanComplete && protocolUniverseComplete && tokenMetadataComplete,
    warnings,
  };
}
