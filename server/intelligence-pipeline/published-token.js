// Official publisher identity + exact ERC20 transfers; this never asserts a historical USD price.
import { Interface, keccak256 } from 'ethers';
import { createPinnedViewCache } from './protocol-source.js';
import { hash, fail, assertHeapBudget } from './storage.js';
import { validateLogs } from '../compact/logs.js';
import { logFilter } from '../compact/sources.js';
import { TRANSFER_TOPIC, ZERO_ADDRESS } from '../../api/_lib/arc-intelligence/usdc.js';
export function createPublishedTokenProcessor(p, { attestation, abi, loadVerifiedWindow } = {}) {
  assertHeapBudget();
  if (attestation?.status !== 'historical_code_presence_verified' || attestation.chainId !== 5042
    || attestation.deploymentTransactionAddressLink !== 'direct_creation'
    || !/^0x[0-9a-f]{40}$/.test(attestation.address ?? '') || hash(JSON.stringify(abi)) !== attestation.abiSha256
    || typeof loadVerifiedWindow !== 'function' || !attestation.views?.symbol || !attestation.views?.decimals)
    fail('published_token_dependencies_missing');
  const iface = new Interface(abi), event = iface.getEvent('Transfer');
  if (event?.topicHash !== TRANSFER_TOPIC || event.inputs.map(v => !!v.indexed).join(',') !== 'true,true,false') fail('published_token_abi_mismatch');
  const stream = { key: 'published_token_transfer', address: [attestation.address], topics: [TRANSFER_TOPIC] };
  const source = { id: 'published_token_' + attestation.address.slice(2, 18), definition: 'published-token-transfer-v1',
    chainId: 5042, address: attestation.address, abiSha256: attestation.abiSha256, publisher: attestation.provenance,
    validFromBlock: attestation.validFromBlock, deploymentCodeHash: attestation.deploymentCodeHash, stream,
    symbol: attestation.views.symbol.value, decimals: Number(attestation.views.decimals.value), valuation: 'independent_price_evidence_required' };
  if (typeof source.symbol !== 'string' || !source.symbol.trim() || source.symbol.length > 64
    || !Number.isInteger(source.decimals) || source.decimals < 0 || source.decimals > 36) fail('published_token_metadata_invalid');
  const resolve = createPinnedViewCache(p);
  return { source, async processJob(j, provider) {
    if (hash(j.spec.source) !== hash(source) || j.first_block < source.validFromBlock) fail('published_token_range_invalid');
    if (loadVerifiedWindow(j.spec.last, j.spec.last).get(j.spec.last)?.hash !== j.spec.anchorHash) fail('published_token_anchor_mismatch');
    for (const n of [...new Set([j.spec.first, j.spec.last])]) {
      const value = await resolve(provider, 'eth_getCode', [source.address, '0x' + n.toString(16)], j.spec.anchorHash);
      if (value === '0x' || keccak256(value) !== source.deploymentCodeHash) fail('published_token_code_version_mismatch');
    }
    const tag = '0x' + j.spec.last.toString(16), proofs = [];
    for (const key of ['symbol', 'decimals']) {
      const data = iface.encodeFunctionData(key, []), value = await resolve(provider, 'eth_call', [{ to: source.address, data }, tag], j.spec.anchorHash);
      const actual = iface.decodeFunctionResult(key, value)[0];
      if (String(actual) !== String(source[key])) fail('published_token_metadata_conflict');
      proofs.push({ key, block: j.spec.last, responseSha256: hash(value) });
    }
    if (!provider.canContinue()) fail('bounded_run_yield');
    const raw = await provider.request('eth_getLogs', [logFilter(stream, j.first_block, j.last_block)]);
    if (!Array.isArray(raw) || raw.length >= 10000) fail('suspect_log_result_count');
    let cached;
    const window = { get(n) { if (!cached?.has(n)) cached = loadVerifiedWindow(n, n); return cached.get(n); } };
    const logs = validateLogs(raw, stream, { fromBlock: j.first_block, toBlock: j.last_block, window, seen: new Set() });
    let amount = 0n, mintCount = 0, burnCount = 0;
    for (const l of logs) {
      const e = iface.parseLog({ topics: l.topics, data: l.data });
      if (!e || l.topics.length !== 3 || !/^0x[0-9a-f]{64}$/.test(l.data)) fail('published_token_event_invalid');
      amount += e.args[2]; if (e.args[0].toLowerCase() === ZERO_ADDRESS) mintCount++; if (e.args[1].toLowerCase() === ZERO_ADDRESS) burnCount++;
    }
    const metrics = { address: source.address, symbol: source.symbol, decimals: source.decimals,
      transferCount: logs.length, mintCount, burnCount, amountRaw: amount.toString() };
    return { summary: { format: 'arc-reduced-source-v1', first: j.first_block, last: j.last_block,
      sourceKey: hash(source), anchorHash: j.spec.anchorHash, inputSha256: hash({ logs, proofs }), status: 'verified', reason: null,
      counts: { transferCount: logs.length }, rows: [{ kind: 'published_asset_transfer_range', metrics, proofs,
        identityBasis: 'official_publisher_address_and_pinned_metadata', usdMicros: null, usdReason: 'same_hour_verified_price_missing' }] } };
  } };
}
