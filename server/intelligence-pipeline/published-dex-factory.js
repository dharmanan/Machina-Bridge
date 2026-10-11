// A separate source version for an officially published DEX; never reinterpret foreign V3 emitters as Uniswap.
import { Interface, keccak256 } from 'ethers';
import { createPinnedViewCache } from './protocol-source.js';
import { hash, fail, assertHeapBudget } from './storage.js';
import { validateLogs } from '../compact/logs.js';
import { logFilter } from '../compact/sources.js';
const A = /^0x[0-9a-f]{40}$/;
export function createPublishedFactoryProcessor(p, { attestation, abi, kind, loadVerifiedWindow } = {}) {
  assertHeapBudget();
  if (!['topaz_cl', 'topaz_stable_volatile'].includes(kind) || typeof loadVerifiedWindow !== 'function'
    || attestation?.status !== 'historical_code_presence_verified' || attestation.chainId !== 5042
    || attestation.deploymentTransactionAddressLink !== 'direct_creation'
    || !A.test(attestation.address ?? '') || hash(JSON.stringify(abi)) !== attestation.abiSha256) fail('published_factory_dependencies_missing');
  const iface = new Interface(abi), event = iface.getEvent('PoolCreated');
  const expectedSignature = kind === 'topaz_cl' ? 'PoolCreated(address,address,int24,address)' : 'PoolCreated(address,address,bool,address,uint256)';
  if (event?.format('sighash') !== expectedSignature || event.inputs.some((v, i) => Boolean(v.indexed) !== (i < 3))) fail('published_factory_abi_mismatch');
  const stream = { key: kind + '_factory', address: [attestation.address], topics: [event.topicHash] };
  const source = { id: kind + '_factory', definition: 'published-factory-creation-v1', chainId: 5042,
    publisher: attestation.provenance, address: attestation.address, abiSha256: attestation.abiSha256,
    deploymentTransaction: attestation.deploymentTransaction, validFromBlock: attestation.validFromBlock,
    deploymentCodeHash: attestation.deploymentCodeHash, stream, tokenIdentity: 'not_inferred_from_pool_creation',
    validityPolicy: 'same_code_at_hour_bounds' };
  const resolve = createPinnedViewCache(p);
  return { source, async processJob(j, provider) {
    if (hash(j.spec.source) !== hash(source) || j.first_block < source.validFromBlock) fail('published_factory_range_invalid');
    if (loadVerifiedWindow(j.spec.last, j.spec.last).get(j.spec.last)?.hash !== j.spec.anchorHash) fail('published_factory_anchor_mismatch');
    for (const n of [...new Set([j.spec.first, j.spec.last])]) {
      const code = await resolve(provider, 'eth_getCode', [source.address, '0x' + n.toString(16)], j.spec.anchorHash);
      if (code === '0x' || keccak256(code) !== source.deploymentCodeHash) fail('published_factory_code_version_mismatch');
    }
    let cached;
    const window = { get(n) { if (!cached?.has(n)) cached = loadVerifiedWindow(n, n); return cached.get(n); } };
    if (!provider.canContinue()) fail('bounded_run_yield');
    const raw = await provider.request('eth_getLogs', [logFilter(stream, j.first_block, j.last_block)]);
    if (!Array.isArray(raw) || raw.length >= 10000) fail('suspect_log_result_count');
    const logs = validateLogs(raw, stream, { fromBlock: j.first_block, toBlock: j.last_block, window, seen: new Set() });
    const rows = [], seen = new Set();
    for (const l of logs) {
      const args = iface.parseLog({ topics: l.topics, data: l.data }).args;
      const token0 = args[0].toLowerCase(), token1 = args[1].toLowerCase(), parameter = args[2], pool = args[3].toLowerCase();
      if (!A.test(pool) || !A.test(token0) || !A.test(token1) || token0 >= token1 || seen.has(pool)) fail('published_pool_creation_invalid');
      seen.add(pool);
      const data = iface.encodeFunctionData('getPool', [token0, token1, parameter]);
      const blockTag = '0x' + l.blockNumber.toString(16);
      const response = await resolve(provider, 'eth_call', [{ to: source.address, data }, blockTag], j.spec.anchorHash);
      if (iface.decodeFunctionResult('getPool', response)[0].toLowerCase() !== pool) fail('published_factory_membership_mismatch');
      rows.push({ kind: 'published_dex_pool_created', protocol: kind, pool, token0, token1,
        ...(kind === 'topaz_cl' ? { tickSpacing: Number(parameter) } : { stable: parameter }),
        factory: source.address, createdBlock: l.blockNumber, createdBlockHash: l.blockHash,
        createdTransaction: l.transactionHash, createdTransactionIndex: l.transactionIndex, createdLogIndex: l.logIndex,
        timestamp: window.get(l.blockNumber).timestamp, factoryResponseSha256: hash(response),
        tokenIdentityStatus: 'unverified', usdValuationStatus: 'not_computed',
        // This proves pool creation, never token deployment, launch, or first-ever swap.
        proof: 'official_factory_event_and_same_block_membership' });
    }
    return { summary: { format: 'arc-reduced-source-v1', first: j.first_block, last: j.last_block,
      sourceKey: hash(source), anchorHash: j.spec.anchorHash, inputSha256: hash({ logs, rows }),
      status: 'verified', reason: null, counts: { poolCreatedCount: rows.length }, rows } };
  } };
}
