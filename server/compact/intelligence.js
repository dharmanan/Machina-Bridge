// Bounded candidate/flow observations from the existing spine and decoders; no independent indexer.
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER } from '../../api/_lib/arc-intelligence/usdc.js';
import { defineEvent, encodeCall, decodeResult } from './abi.js';
import { codeIsPresent } from './registry.js';
import { decodeAbiText } from './token-metadata.js';
import { INTELLIGENCE_REGISTRY, INTELLIGENCE_VERSION, addressOf, registryDigest } from './intelligence-registry.js';
import { usdMicrosOf, anchorDecimals, priceableDecimals } from './valuation.js';
import { verifyCompactLaunchSource } from './launch-sources.js';

export const DISCOVERY_LIMIT_PER_HOUR = 2048;
export const DISCOVERY_READS_PER_RUN = 16;
const ZERO = `0x${'0'.repeat(40)}`;
const transfer = defineEvent('event Transfer(address indexed from, address indexed to, uint256 amount)');
const hex = (n) => `0x${n.toString(16)}`;
const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString(10) : item);
const evidenceOf = (block, index) => ({ txHash: block.txHashes[index], blockNumber: block.number, blockHash: block.hash,
  timestamp: block.timestamp, transactionIndex: index, deployer: block.txFrom[index], readBlock: null });
// One historical answer is 'ok', 'rejected' (a deterministic EVM answer at the pinned tag) or 'retry' (missing answer or
// provider error). Only an EVM revert counts as an execution answer; any other item error stays retryable.
const reverted = (answer) => answer?.error?.code === 3 || /revert/i.test(answer?.error?.message ?? '');
const hexAnswer = (answer) => typeof answer?.result === 'string' && /^0x[0-9a-f]*$/i.test(answer.result);
const codeOutcome = (answer) => !hexAnswer(answer) ? 'retry' : codeIsPresent(answer.result) ? 'ok' : 'rejected';
const viewOutcome = (answer) => hexAnswer(answer) ? (decodeResult(['uint256'], answer.result) ? 'ok' : 'rejected') : reverted(answer) ? 'rejected' : 'retry';
const probeOutcome = (answer) => hexAnswer(answer) ? (answer.result === '0x' ? 'ok' : 'rejected') : reverted(answer) ? 'ok' : 'retry';
const launchInRange = (source, block) => source.validFromBlock === null || block >= source.validFromBlock;
const launchSourceOf = (candidate, registry) => candidate.launchEvidence && registry.launches.find(entry =>
  entry.addresses.includes(candidate.launchEvidence.emitter) && entry.version === candidate.launchEvidence.version
  && entry.events.some(spec => spec.event.signature === candidate.launchEvidence.eventSignature)
  && launchInRange(entry, candidate.blockNumber));
const factoryEvidence = (result, blockNumber) => ({ blockTag: hex(blockNumber), status: result.status,
  codePresent: result.codePresent ?? null, eventTopic: result.eventTopic ?? null,
  eventTopicInBytecode: result.eventTopicInBytecode === true, viewVerified: result.viewVerified === true,
  viewResult: result.viewResult ?? null, reason: result.verificationReason ?? null });

export function classifyLaunch(candidate, registry = INTELLIGENCE_REGISTRY) {
  const source = launchSourceOf(candidate, registry);
  if (source && candidate.launchEvidence.codeVerified === true
    && (!source.factoryVerification || candidate.launchEvidence.factoryEvidence?.status === 'verified')) return { status: source.classification, source: source.id,
    protocol: source.protocol ?? null, version: source.version, sourceDefinitionVersion: source.sourceDefinitionVersion ?? null,
    observedAt: candidate.timestamp, blockNumber: candidate.blockNumber,
    logIndex: candidate.launchEvidence.logIndex, transactionHash: candidate.txHash,
    creator: source.events.find(spec => spec.event.signature === candidate.launchEvidence.eventSignature)?.creatorField
      && addressOf(candidate.launchEvidence.creator) ? { status: 'available', address: candidate.launchEvidence.creator, basis: 'official_event_field' }
      : { status: 'unavailable', reason: 'creator_not_in_official_event' },
    provenance: { source: source.source, verificationBasis: source.verificationBasis, evidence: candidate.launchEvidence,
      transactionHash: candidate.txHash, blockHash: candidate.blockHash } };
  if (candidate.directDeploymentVerified === true) return { status: 'direct_deployment', source: null,
    observedAt: candidate.timestamp, blockNumber: candidate.blockNumber,
    provenance: { basis: 'successful_top_level_creation_receipt', transactionHash: candidate.txHash, blockHash: candidate.blockHash } };
  return { status: 'unknown_source', source: null, provenance: null };
}

export function createIntelligenceSink({ registry = INTELLIGENCE_REGISTRY, limit = DISCOVERY_LIMIT_PER_HOUR } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOVERY_LIMIT_PER_HOUR) throw new Error('invalid_discovery_limit');
  const candidates = new Map();
  const first = new Map();
  const flows = new Map();
  const extensions = new Map();
  const launchProofs = new Map();
  let capped = false;
  let dexCapped = false;
  const candidateCaps = new Set(), dexCaps = new Set();
  let transferError = false;
  const addCandidate = (candidate) => {
    const key = candidate.kind === 'creation' ? candidate.txHash : `${candidate.kind}:${candidate.address}:${candidate.txHash}`
      + (candidate.kind === 'source' ? `:${candidate.launchEvidence.version}` : '');
    if (candidates.has(key)) return;
    if (candidates.size === limit) {
      capped = true;
      candidateCaps.add(candidate.kind === 'pool' ? candidate.poolEvidence.protocol : candidate.kind === 'source'
        ? `${candidate.launchEvidence.emitter}:${candidate.launchEvidence.version}` : 'creations');
      return;
    }
    candidates.set(key, { key, ...candidate });
  };
  const mark = (kind, entry) => {
    const key = `${kind}:${entry.id}`;
    if (!extensions.has(key)) extensions.set(key, { kind, id: entry.id, version: entry.version, source: entry.source,
      verificationBasis: entry.verificationBasis, address: entry.address, status: 'available', reason: null,
      counts: Object.fromEntries(entry.events.filter((spec) => spec.metric).map((spec) => [spec.metric, 0])), rawFlows: {} });
    return extensions.get(key);
  };
  for (const entry of registry.launches) mark('launch', entry);
  for (const entry of registry.protocols) mark('protocol', entry);
  const poolTokens = (protocol, pool, tokens, block, index) => {
    for (const address of tokens) if (addressOf(address) && address !== ZERO && !registry.assets.some((asset) => asset.address === address)) {
      addCandidate({ kind: 'pool', address, ...evidenceOf(block, index), caller: block.txFrom[index], deployer: null,
        poolEvidence: { protocol, pool, basis: 'existing_official_pool_creation_decoder' } });
    }
  };
  const dex = (protocol, kind, log, event, window) => {
    if (!['swap', 'mint', 'modify', 'initialize', 'creation'].includes(kind) || kind === 'modify' && event.classification !== 'increase') return;
    const activity = ['initialize', 'creation'].includes(kind) ? 'creation' : kind === 'swap' ? 'swap' : 'liquidity';
    const pool = protocol === 'uniswap_v3' ? log.address : event.poolId;
    const key = `${protocol}:${pool}:${activity}`;
    const block = window.get(log.blockNumber);
    if (!block) return;
    if (kind === 'initialize') poolTokens(protocol, pool, [event.currency0, event.currency1], block, log.transactionIndex);
    const row = { protocol, pool, activity, blockNumber: log.blockNumber, logIndex: log.logIndex,
      timestamp: block.timestamp, txHash: log.transactionHash };
    const previous = first.get(key);
    if (!previous && first.size >= DISCOVERY_LIMIT_PER_HOUR * 2) { dexCapped = true; dexCaps.add(protocol); return; }
    if (!previous || row.blockNumber < previous.blockNumber || row.blockNumber === previous.blockNumber && row.logIndex < previous.logIndex) first.set(key, row);
  };
  return Object.freeze({
    async verifyLaunchSources(provider, { firstBlock, lastBlock }) {
      for (const entry of registry.launches.filter(entry => entry.factoryVerification)) {
        const end = factoryEvidence(await verifyCompactLaunchSource(provider, entry, lastBlock), lastBlock);
        // A missing deployment boundary is not genesis evidence. Establish code/topic/view at both window edges.
        const start = entry.validFromBlock === null && end.status === 'verified'
          ? factoryEvidence(await verifyCompactLaunchSource(provider, entry, firstBlock), firstBlock) : null;
        launchProofs.set(entry.id, { firstBlock, lastBlock, end, start,
          status: end.status === 'verified' && (entry.validFromBlock !== null || start?.status === 'verified') ? 'verified' : 'unavailable' });
      }
    },
    blocks(blocks) {
      for (const block of blocks) for (let index = 0; index < block.txTo.length; index++) if (block.txTo[index] === null) {
        addCandidate({ kind: 'creation', address: null, ...evidenceOf(block, index) });
      }
    },
    dex,
    poolCreated(record, window) {
      const block = window.get(record.createdBlock);
      if (block) poolTokens('uniswap_v3', record.address, [record.token0, record.token1], block, block.txHashes.indexOf(record.createdTx));
      dex('uniswap_v3', 'creation', { address: record.address, blockNumber: record.createdBlock, logIndex: record.createdLogIndex,
        transactionHash: record.createdTx }, {}, window);
    },
    transfers(logs) {
      if (!registry.exchanges.length) return;
      for (const log of logs) {
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        const asset = registry.assets.find((entry) => (entry.interfaces?.canonicalTransferEmitter ?? entry.address).toLowerCase() === log.address);
        if (!asset) continue; // USDC interface logs can never enter native canonical flows.
        const values = transfer.decode(log);
        if (!values) { transferError = true; return; }
        const decimals = asset.interfaces?.canonicalTransferEmitter ? asset.interfaces.nativeDecimals : asset.decimals;
        for (const entry of registry.exchanges) {
          if (log.blockNumber < entry.validFromBlock) continue;
          for (const direction of ['inbound', 'outbound']) {
            const matches = direction === 'inbound' ? values.to === entry.address && values.from !== entry.address
              : values.from === entry.address && values.to !== entry.address;
            if (!matches) continue;
            const key = `${entry.id}:${asset.address}:${direction}:${decimals}`;
            if (!flows.has(key)) flows.set(key, { entity: entry.id, asset: asset.address, direction, decimals,
              emitter: log.address, count: 0, amount: 0n, version: entry.version, source: entry.source });
            const row = flows.get(key); row.count += 1; row.amount += values.amount;
          }
        }
      }
    },
    extension(stream, logs, window) {
      const row = mark(stream.kind, stream.entry);
      if (row.status !== 'available') return;
      for (const log of logs) {
        if (!stream.entry.addresses.includes(log.address)) { row.status = 'unavailable'; row.reason = 'registered_emitter_mismatch'; return; }
        if (stream.entry.validFromBlock !== null && log.blockNumber < stream.entry.validFromBlock) continue;
        const spec = stream.entry.events.find((item) => item.event.topic === log.topics[0]);
        const event = spec?.event.decode(log);
        if (!event) { row.status = 'unavailable'; row.reason = 'malformed_registered_event'; return; }
        if (stream.kind === 'launch') {
          const block = window.get(log.blockNumber);
          if (!block || !addressOf(event[spec.tokenField]) || event[spec.tokenField] === ZERO) {
            row.status = 'unavailable'; row.reason = 'invalid_launch_identity'; return;
          }
          addCandidate({ kind: 'source', address: event[spec.tokenField], ...evidenceOf(block, log.transactionIndex),
            caller: block.txFrom[log.transactionIndex], deployer: null,
            launchEvidence: { emitter: log.address, version: stream.entry.version, logIndex: log.logIndex,
              eventSignature: spec.event.signature, creator: spec.creatorField ? event[spec.creatorField] : null, codeVerified: false } });
        } else {
          row.counts[spec.metric] = (row.counts[spec.metric] ?? 0) + 1;
          if (spec.aggregation === 'per_asset_raw_sum') {
            const key = `${spec.metric}:${event[spec.assetField]}`;
            if (!Object.hasOwn(row.rawFlows, key) && Object.keys(row.rawFlows).length >= 256) {
              row.status = 'unavailable'; row.reason = 'protocol_asset_limit'; return;
            }
            row.rawFlows[key] = (BigInt(row.rawFlows[key] ?? '0') + event[spec.amountField]).toString(10);
          }
        }
      }
    },
    failExtension(stream) { const row = mark(stream.kind, stream.entry); row.status = 'unavailable'; row.reason = 'registered_stream_unavailable'; },
    finish({ range, families, codePresent, projections }) {
      for (const stream of extensions.values()) {
        const entry = registry[stream.kind === 'launch' ? 'launches' : 'protocols'].find(entry => entry.id === stream.id);
        if (!entry?.factoryVerification && !entry?.addresses.every(codePresent)) {
          stream.status = 'unavailable'; stream.reason = 'registered_code_unavailable';
        }
      }
      for (const stream of extensions.values()) if (registry[stream.kind === 'launch' ? 'launches' : 'protocols']
        .find((entry) => entry.id === stream.id)?.validFromBlock > range.firstBlock) {
        stream.status = 'unavailable'; stream.reason = 'registry_not_valid_for_entire_range';
      }
      for (const stream of extensions.values()) if (stream.kind === 'launch') {
        const entry = registry.launches.find(entry => entry.id === stream.id);
        if (!entry.factoryVerification) continue;
        const proof = launchProofs.get(entry.id);
        stream.factoryEvidence = proof ?? { status: 'unavailable', reason: 'factory_verification_not_run' };
        stream.validFromBlock = entry.validFromBlock; stream.validityBasis = entry.validityBasis;
        stream.protocol = entry.protocol; stream.sourceDefinitionVersion = entry.sourceDefinitionVersion;
        if (stream.status === 'available' && (proof?.status !== 'verified'
          || proof.firstBlock !== range.firstBlock || proof.lastBlock !== range.lastBlock)) {
          stream.status = 'unavailable'; stream.reason = 'registered_factory_unverified';
        }
      }
      const registryInRange = registry.exchanges.every((entry) => entry.validFromBlock <= range.firstBlock);
      const transferComplete = registryInRange && !transferError && families.usdc?.status === 'available' && families.assets?.status === 'available';
      const launchComplete = [...extensions.values()].filter((row) => row.kind === 'launch').every((row) => row.status === 'available');
      const poolDiscoveryComplete = families.uniswapV3?.status === 'available' && families.uniswapV4?.status === 'available'
        && projections?.uniswap_v3_pools?.status === 'available' && projections?.uniswap_v4_pools?.status === 'available';
      const validCandidates = [...candidates.values()].filter((row) => row.kind !== 'pool'
        || projections?.[`${row.poolEvidence.protocol}_pools`]?.status === 'available')
        .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.key.localeCompare(b.key));
      return { version: INTELLIGENCE_VERSION, registryDigest: registryDigest(registry), registryDefinition: registry, range,
        // Internal per-component completeness survives an unrelated source/family failure or a shared list cap.
        discoveryComponents: { creations: !candidateCaps.has('creations'),
          ...Object.fromEntries(['uniswap_v3', 'uniswap_v4'].map(protocol => [protocol,
            families[protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4']?.status === 'available'
            && projections?.[`${protocol}_pools`]?.status === 'available' && !candidateCaps.has(protocol) && !dexCaps.has(protocol)])),
          launches: Object.fromEntries(registry.launches.map(entry => [entry.id, extensions.get(`launch:${entry.id}`)?.status === 'available'
            && !entry.addresses.some(a => candidateCaps.has(`${a}:${entry.version}`))])) },
        discovery: { scope: 'top_level_creations_and_registered_sources',
          status: capped || !launchComplete || !poolDiscoveryComplete ? 'insufficient_coverage' : 'available',
          reason: capped ? 'candidate_limit' : !launchComplete ? 'registered_launch_scan_unavailable'
            : !poolDiscoveryComplete ? 'pool_discovery_unavailable' : null, internalCreations: 'not_supported',
          allArcTokensComplete: false, poolTokens: 'additional_verified_pool_observations_not_deployment_universe',
          candidates: validCandidates.map((row) => ({ ...row, readBlock: range.lastBlock })) },
        firstDex: [...first.values()].filter((row) => families[row.protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4']?.status === 'available'
          && projections?.[`${row.protocol}_pools`]?.status === 'available')
          .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.pool.localeCompare(b.pool) || a.activity.localeCompare(b.activity)),
        firstDexComplete: !dexCapped && poolDiscoveryComplete,
        firstDexLimited: dexCapped, // Internal completeness flag for a recovery unit scoped to one pool protocol.
        exchange: { status: !registry.exchanges.length ? 'unavailable' : transferComplete ? 'available' : 'insufficient_coverage',
          reason: !registry.exchanges.length ? 'verified_exchange_registry_empty' : !registryInRange ? 'registry_not_valid_for_entire_range'
            : transferComplete ? null : 'transfer_family_unavailable',
          registryVersions: registry.exchanges.map((entry) => `${entry.id}:${entry.address}:${entry.version}`).sort(),
          rows: transferComplete ? [...flows.values()].map(({ amount, ...row }) => ({ ...row, amountRaw: amount.toString(10) }))
            .sort((a, b) => a.entity.localeCompare(b.entity) || a.asset.localeCompare(b.asset) || a.direction.localeCompare(b.direction)) : [] },
        protocols: [...extensions.values()].filter((row) => row.kind === 'protocol').map((row) => row.status === 'available' ? row : { ...row, counts: null, rawFlows: null }),
        launchSources: [...extensions.values()].filter((row) => row.kind === 'launch'),
      };
    },
  });
}

// Required behavior (code + totalSupply + balanceOf), not labels. Optional metadata never promotes an asset or a launch.
// Three outcomes: verified_erc20_like; rejected_not_erc20_like (resolved negative at the pinned tag: terminal, never
// retried, never unresolved, never a token or launch); unverified (retryable: transient, missing or inconsistent answers).
export async function verifyTokenCandidate(provider, candidate, { registry = INTELLIGENCE_REGISTRY } = {}) {
  const out = { ...candidate, status: 'unverified', reason: 'required_token_views_unavailable', symbol: null, name: null,
    decimals: null, directDeploymentVerified: false, launch: { status: 'unknown_source', source: null, provenance: null } };
  try {
    if (candidate.kind === 'creation') {
      const receipt = await provider.request('eth_getTransactionReceipt', [candidate.txHash]);
      const identical = receipt && receipt.transactionHash?.toLowerCase() === candidate.txHash && receipt.blockHash?.toLowerCase() === candidate.blockHash
        && receipt.blockNumber === hex(candidate.blockNumber) && receipt.transactionIndex === hex(candidate.transactionIndex)
        && addressOf(receipt.from) === candidate.deployer && receipt.to === null;
      // The canonical creation itself failed: no code was deployed, so nothing can ever verify.
      if (identical && receipt.status === '0x0') return { ...out, status: 'rejected_not_erc20_like', reason: 'deployment_failed' };
      if (!identical || receipt.status !== '0x1' || !addressOf(receipt.contractAddress)) {
        return { ...out, reason: 'deployment_receipt_unverified' };
      }
      out.address = addressOf(receipt.contractAddress);
      out.directDeploymentVerified = true;
    }
    if (!addressOf(out.address) || !Number.isSafeInteger(candidate.readBlock) || candidate.readBlock < candidate.blockNumber) return out;
    const tag = hex(candidate.readBlock);
    const calls = [['eth_getCode', [out.address, tag]], ...['totalSupply()', 'balanceOf(address)', 'symbol()', 'name()', 'decimals()'].map((signature) =>
      ['eth_call', [{ to: out.address, data: encodeCall(signature, signature === 'balanceOf(address)' ? [['address', ZERO]] : []) }, tag]])];
    const source = launchSourceOf(candidate, registry);
    if (source && !source.factoryVerification) calls.push(['eth_getCode', [candidate.launchEvidence.emitter, tag]]);
    // Negative control: a generic fallback returning uint256 for every selector is not token behavior.
    const probeIndex = calls.length;
    calls.push(['eth_call', [{ to: out.address, data: encodeCall('machinaIntelligenceUnknownSelector()') }, tag]]);
    const answers = await provider.batch(calls, { allowItemErrors: true });
    // Fixed order; the first check that does not pass decides, so the final outcome never depends on which answer was transient.
    const failed = [[codeOutcome(answers[0]), 'contract_code_absent', 'required_token_views_unavailable'],
      [viewOutcome(answers[1]), 'required_token_views_rejected', 'required_token_views_unavailable'],
      [viewOutcome(answers[2]), 'required_token_views_rejected', 'required_token_views_unavailable'],
      [probeOutcome(answers[probeIndex]), 'token_behavior_negative_control_failed', 'token_behavior_negative_control_unavailable']]
      .find(([outcome]) => outcome !== 'ok');
    if (failed) return failed[0] === 'rejected' ? { ...out, status: 'rejected_not_erc20_like', reason: failed[1] } : { ...out, reason: failed[2] };
    out.symbol = decodeAbiText(answers[3]?.result); out.name = decodeAbiText(answers[4]?.result);
    const decimals = decodeResult(['uint256'], answers[5]?.result)?.[0];
    out.decimals = decimals !== undefined && decimals <= 255n ? Number(decimals) : null;
    out.status = 'verified_erc20_like'; out.reason = null;
    out.verification = { basis: 'historical_code_totalSupply_balanceOf_with_negative_control', blockTag: tag,
      scope: 'erc20_like_not_full_standard_or_proxy_identity' };
    if (source?.factoryVerification) {
      const proof = factoryEvidence(await verifyCompactLaunchSource(provider, source, candidate.readBlock), candidate.readBlock);
      out.launchEvidence = { ...candidate.launchEvidence, codeVerified: proof.status === 'verified', factoryEvidence: proof };
    } else if (source) out.launchEvidence = { ...candidate.launchEvidence, codeVerified: codeIsPresent(answers[6]?.result) };
    out.launch = classifyLaunch(out, registry);
    return out;
  } catch { return { ...out, reason: 'candidate_rpc_unavailable' }; }
}

// Only accepted production pricing policy. USDC system flows carry native 18 decimals; no 6-decimal substitution.
export function valueExchangeFlow(row, prices) {
  const token = row.emitter === USDC_SYSTEM_EMITTER.toLowerCase() ? ZERO : row.asset;
  const decimals = anchorDecimals(token) ?? priceableDecimals(token);
  const value = decimals === row.decimals ? usdMicrosOf(token, BigInt(row.amountRaw), prices) : null;
  return { ...row, usd: value === null ? { status: 'unavailable', reason: 'verified_price_unavailable', usdMicros: null }
    : { status: 'available', reason: null, usdMicros: value.toString(10), basis: 'existing_compact_hour_price_policy' } };
}

export async function refreshDiscovery({ store, provider, now = Date.now(), limit = DISCOVERY_READS_PER_RUN }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOVERY_READS_PER_RUN) throw new Error('invalid_discovery_read_limit');
  const pending = store.intelligence.pending({ now, limit });
  const results = [];
  for (const candidate of pending) {
    const result = await verifyTokenCandidate(provider, candidate);
    store.intelligence.recordVerification(result, { now });
    results.push({ status: result.status, reason: result.reason });
  }
  return { candidates: pending.length, verified: results.filter((row) => row.status === 'verified_erc20_like').length,
    rejected: results.filter((row) => row.status === 'rejected_not_erc20_like').length,
    unresolved: results.filter((row) => row.status === 'unverified').length };
}

// Enrichment is independent of the committed hour. Never expose provider/DB exception text.
export async function refreshDiscoverySafely(options) {
  try { return { status: 'available', ...(await refreshDiscovery(options)) }; }
  catch { return { status: 'unavailable', reason: 'discovery_refresh_unavailable' }; }
}

export const intelligenceJson = stringify;
