// P8: reuse the existing official P1A definitions and factory verifier. No discovery scan or guessed deployment floor.
import { P1A_LAUNCHPAD_CANDIDATES } from '../../api/_lib/arc-intelligence/p1a-registry.js';
import { LAUNCHPADS_DEFINITION_VERSION, verifyFactory } from '../../api/_lib/arc-intelligence/launchpad-adapters/common.js';
import { ARGUS_ADAPTER } from '../../api/_lib/arc-intelligence/launchpad-adapters/argus.js';
import { TOLLY_ADAPTER } from '../../api/_lib/arc-intelligence/launchpad-adapters/tolly.js';
import { OPENLAUNCH_ADAPTER } from '../../api/_lib/arc-intelligence/launchpad-adapters/openlaunch.js';
import { ARCHEMIST_V2_ADAPTER } from '../../api/_lib/arc-intelligence/launchpad-adapters/archemist-v2.js';

const adapters = new Map([ARGUS_ADAPTER, TOLLY_ADAPTER, OPENLAUNCH_ADAPTER, ARCHEMIST_V2_ADAPTER]
  .map(adapter => [adapter.protocol, adapter]));
const declarationOf = abi => `event ${abi.name}(${abi.inputs.map(input =>
  `${input.type}${input.indexed ? ' indexed' : ''} ${input.name}`).join(', ')})`;

export const COMPACT_LAUNCH_SOURCES = Object.freeze(P1A_LAUNCHPAD_CANDIDATES
  .filter(candidate => adapters.has(candidate.protocol) && candidate.verificationStatus === 'source_verified_candidate')
  .map(candidate => {
    const adapter = adapters.get(candidate.protocol);
    return Object.freeze({
      id: candidate.protocol.toLowerCase().replaceAll(' ', '_'), chainId: candidate.chainId,
      protocol: candidate.protocol, version: candidate.version, address: candidate.address,
      source: candidate.source, sourceKey: candidate.sourceKey, verificationStatus: candidate.verificationStatus,
      sourceDefinitionVersion: LAUNCHPADS_DEFINITION_VERSION,
      verificationBasis: 'existing_P1A_official_ABI_factory_code_event_topic_and_adapter_view',
      validFromBlock: candidate.effectiveFromBlock,
      validityBasis: candidate.effectiveFromBlock === null ? 'deployment_boundary_not_established' : 'existing_P1A_deployment_boundary',
      classification: 'verified_launchpad', codeAssumption: 'present_at_window_end',
      factoryVerification: 'existing_P1A_code_topic_view',
      requiredView: adapter.view?.signature ?? null,
      events: Object.freeze([Object.freeze({ declaration: declarationOf(adapter.abi), tokenField: 'token', creatorField: adapter.creatorField })]),
    });
  }));

// Bound this policy to the existing definitions; an ecosystem listing, altered ABI or guessed mapping cannot opt in.
export function matchesOfficialLaunchSource(entry) {
  const official = COMPACT_LAUNCH_SOURCES.find(source => source.id === entry.id);
  return Boolean(official) && ['chainId', 'protocol', 'version', 'source', 'sourceKey', 'sourceDefinitionVersion',
    'verificationStatus', 'verificationBasis', 'validFromBlock', 'validityBasis', 'classification', 'codeAssumption',
    'factoryVerification', 'requiredView'].every(field => entry[field] === official[field])
    && entry.address?.toLowerCase() === official.address
    && (entry.addresses === undefined || entry.addresses.length === 1 && entry.addresses[0]?.toLowerCase() === official.address)
    && entry.events?.length === 1 && ['declaration', 'tokenField', 'creatorField'].every(field => entry.events[0][field] === official.events[0][field]);
}

export async function verifyCompactLaunchSource(provider, entry, blockNumber) {
  if (!matchesOfficialLaunchSource(entry) || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    return { status: 'unavailable', verificationReason: 'official_launch_definition_mismatch' };
  }
  const candidate = P1A_LAUNCHPAD_CANDIDATES.find(candidate => candidate.protocol === entry.protocol);
  return verifyFactory(candidate, adapters.get(entry.protocol), provider, `0x${blockNumber.toString(16)}`);
}
