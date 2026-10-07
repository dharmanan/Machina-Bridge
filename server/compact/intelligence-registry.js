// Additive compact intelligence registries. An empty registry is unavailable, never a guessed source.
// Adding an entry requires authoritative address/ABI evidence and a new stable definition version.
import { ARC_VERIFIED_ASSETS, validateVerifiedAssetRegistry } from '../../api/_lib/arc-intelligence/assets.js';
import { defineEvent } from './abi.js';
import { PROTOCOL_FAMILIES } from './protocols/index.js';
import { createHash } from 'node:crypto';
import { COMPACT_LAUNCH_SOURCES, matchesOfficialLaunchSource } from './launch-sources.js';

export const INTELLIGENCE_VERSION = 'arc-compact-ecosystem-v1';
export const ECOSYSTEM_SCHEMA = 'machina.intelligence.ecosystem.v1';
export const ECOSYSTEM_WINDOWS = Object.freeze({ '24h': 24, '7d': 168, '30d': 720 });
export const VERIFIED_LAUNCH_SOURCES = COMPACT_LAUNCH_SOURCES;
export const VERIFIED_EXCHANGE_ADDRESSES = Object.freeze([]);
export const ADDITIONAL_VERIFIED_PROTOCOLS = Object.freeze([]);
export const addressOf = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const nonempty = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Protocol aggregations support event counts and per-asset unsigned raw flows only. No implicit TVL/APY/USD.
export function intelligenceRegistry({ launches = VERIFIED_LAUNCH_SOURCES, exchanges = VERIFIED_EXCHANGE_ADDRESSES,
  protocols = ADDITIONAL_VERIFIED_PROTOCOLS, assets = ARC_VERIFIED_ASSETS } = {}) {
  validateVerifiedAssetRegistry(assets);
  const emitters = new Set();
  for (const asset of assets) {
    if (!nonempty(asset.category) || !nonempty(asset.verification?.type)) throw new Error('invalid_asset_provenance');
    const emitter = addressOf(asset.interfaces?.canonicalTransferEmitter ?? asset.address);
    if (!emitter || emitters.has(emitter)) throw new Error('duplicate_asset_transfer_stream');
    if (asset.interfaces && (!Number.isSafeInteger(asset.interfaces.nativeDecimals) || asset.interfaces.nativeDecimals < 0
      || asset.interfaces.nativeDecimals > 255)) throw new Error('invalid_asset_native_units');
    emitters.add(emitter);
  }
  const seen = new Set();
  const identity = (entry, kind) => {
    const address = addressOf(entry.address);
    if (entry.chainId !== 5042 || !address || !nonempty(entry.id) || !nonempty(entry.version)
      || !nonempty(entry.source) || !nonempty(entry.verificationBasis)
      || !(Number.isSafeInteger(entry.validFromBlock) && entry.validFromBlock >= 0
        || kind === 'launch' && entry.validFromBlock === null && matchesOfficialLaunchSource(entry))) throw new Error('invalid_intelligence_registry');
    const key = `${kind}:${address}`;
    if (seen.has(key)) throw new Error('duplicate_intelligence_registry');
    seen.add(key);
    return { ...entry, address };
  };
  const withEvents = (entry, kind) => {
    const addresses = (entry.addresses ?? [entry.address]).map(addressOf);
    if (!addresses.length || addresses.length > 16 || addresses.some((address) => !address)
      || new Set(addresses).size !== addresses.length) throw new Error('invalid_protocol_addresses');
    const out = identity({ ...entry, address: addresses[0] }, kind);
    for (const address of addresses.slice(1)) identity({ ...entry, address }, kind);
    out.addresses = Object.freeze(addresses);
    if (entry.codeAssumption !== 'present_at_window_end' || !Array.isArray(entry.events)
      || !entry.events.length || entry.events.length > 8) throw new Error('invalid_protocol_definition');
    out.events = entry.events.map((spec) => {
      const event = defineEvent(spec.declaration);
      if (kind === 'launch') {
        if (!['verified_factory', 'verified_launchpad'].includes(entry.classification)
          || !event.inputs.some((field) => field.name === spec.tokenField && field.type === 'address')
          || spec.creatorField != null && !event.inputs.some(field => field.name === spec.creatorField && field.type === 'address')
          || entry.verificationStatus !== undefined && entry.verificationStatus !== 'source_verified_candidate'
          || entry.factoryVerification !== undefined && !matchesOfficialLaunchSource(entry)) throw new Error('invalid_launch_definition');
      } else {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.metric ?? '') || ['constructor', 'prototype'].includes(spec.metric)
          || !['count', 'per_asset_raw_sum'].includes(spec.aggregation)) throw new Error('invalid_protocol_definition');
        if (spec.aggregation === 'per_asset_raw_sum' && (!event.inputs.some((field) => field.name === spec.assetField && field.type === 'address')
          || !event.inputs.some((field) => field.name === spec.amountField && /^uint\d+$/.test(field.type)))) throw new Error('invalid_protocol_definition');
      }
      return Object.freeze({ ...spec, event });
    });
    if (new Set(out.events.map((spec) => spec.event.topic)).size !== out.events.length) throw new Error('duplicate_protocol_event');
    return Object.freeze(out);
  };
  if (launches.length > 16 || protocols.length > 16 || exchanges.length > 32 || assets.length > 64) throw new Error('registry_limit');
  for (const entries of [launches, protocols]) if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('duplicate_protocol_identity');
  for (const entity of new Set(exchanges.map((entry) => entry.id))) {
    if (new Set(exchanges.filter((entry) => entry.id === entity).map((entry) => entry.version)).size !== 1) throw new Error('mixed_exchange_definition');
  }
  return Object.freeze({ assets: assets.map((asset) => Object.freeze({ ...asset, address: addressOf(asset.address),
    ...(asset.interfaces ? { interfaces: { ...asset.interfaces, canonicalTransferEmitter: addressOf(asset.interfaces.canonicalTransferEmitter) } } : {}) })),
    launches: launches.map((entry) => withEvents(entry, 'launch')),
    exchanges: exchanges.map((entry) => Object.freeze(identity(entry, 'exchange'))),
    protocols: protocols.map((entry) => withEvents(entry, 'protocol')) });
}

export const INTELLIGENCE_REGISTRY = intelligenceRegistry();
export const registryDigest = (registry = INTELLIGENCE_REGISTRY) => createHash('sha256').update(JSON.stringify(registry,
  (_key, value) => typeof value === 'function' ? undefined : value)).digest('hex');
export const existingProtocolDefinitions = () => PROTOCOL_FAMILIES.map((family) => ({ id: family.name, version: family.version,
  source: 'existing_verified_compact_family', addresses: family.codeAddresses, streams: family.streams.map((stream) => ({
    key: stream.key, addresses: stream.address, topics: stream.topics })), aggregation: 'existing_family_definition' }));

export function extensionStreams(registry) {
  return [...registry.launches.map((entry) => ['launch', entry]), ...registry.protocols.map((entry) => ['protocol', entry])]
    .map(([kind, entry]) => ({ key: `ecosystem:${kind}:${entry.id}`, kind, entry,
      topics: entry.events.map((spec) => spec.event.topic), address: entry.addresses, maxRange: 500 }));
}
