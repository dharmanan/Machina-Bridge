// No network. Codespace Node 24 acceptance, real in-memory node:sqlite; no production file or provider is opened.
import { boundEcosystemResponse } from '../server/compact/intelligence-store.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { defineEvent, selectorOf } from '../server/compact/abi.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { createIntelligenceSink as createSink, classifyLaunch, verifyTokenCandidate, refreshDiscovery, refreshDiscoverySafely, valueExchangeFlow } from '../server/compact/intelligence.js';
import { intelligenceRegistry, INTELLIGENCE_REGISTRY, INTELLIGENCE_VERSION, ECOSYSTEM_SCHEMA, registryDigest, extensionStreams } from '../server/compact/intelligence-registry.js';
import { readEcosystem as readModel, correlateDex as dexModel, sumExchange, sumProtocols, discoveryWorkDue } from '../server/compact/intelligence-store.js';
import { createIntelligenceHandler } from '../server/compact/http.js';
import { resolveIntelligenceRoute, handleIntelligenceProxy } from '../api/_lib/intelligence-proxy.js';
import { USDC_SYSTEM_EMITTER } from '../api/_lib/arc-intelligence/usdc.js';
import { processBlockRange } from '../server/compact/hour.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { headerOf } from '../server/compact/spine.js';
import { drainDiscovery, discoveryDrainConfig } from './drain-compact-discovery.mjs';

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
globalThis.fetch = async () => { throw new Error('network_forbidden'); };
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const TOKEN = address(800); const DEPLOYER = address(900); const EXCHANGE = address(901); const SOURCE = address(902);
const BASE = Date.parse('2026-10-05T09:00:00Z') / 1000;
const regEntry = { id: 'fixture', address: SOURCE, chainId: 5042, version: 'fixture-v1', source: 'synthetic_official_fixture',
  verificationBasis: 'synthetic_test_only', validFromBlock: 0, codeAssumption: 'present_at_window_end' };
// Existing generic discovery fixtures intentionally omit launch streams. P8 has its own official-source acceptance.
const discoveryRegistry = intelligenceRegistry({ launches: [] });
const createIntelligenceSink = (options = {}) => createSink({ registry: discoveryRegistry, ...options });
const readEcosystem = (db, windowKey, options = {}) => readModel(db, windowKey, { registry: discoveryRegistry, ...options });
const correlateDex = (db, token, through, options = {}) => dexModel(db, token, through, { registry: discoveryRegistry, ...options });
const registry = intelligenceRegistry({ exchanges: [{ ...regEntry, address: EXCHANGE }], launches: [{ ...regEntry,
  classification: 'verified_factory', events: [{ declaration: 'event Created(address indexed token)', tokenField: 'token' }] }],
  protocols: [{ ...regEntry, events: [{ declaration: 'event Supplied(address indexed asset, uint256 amount)', metric: 'supply',
    aggregation: 'per_asset_raw_sum', assetField: 'asset', amountField: 'amount' }] }] });
const candidate = { key: hash(101), kind: 'creation', address: null, txHash: hash(101), blockNumber: 101, blockHash: hash(101),
  timestamp: BASE + 10, transactionIndex: 0, deployer: DEPLOYER, readBlock: 109 };
const receipt = { transactionHash: hash(101), blockHash: hash(101), blockNumber: '0x65', transactionIndex: '0x0', from: DEPLOYER,
  to: null, status: '0x1', contractAddress: TOKEN };
const values = { 'totalSupply()': `0x${word(10n ** 50n)}`, 'balanceOf(address)': `0x${word(0)}`,
  'symbol()': `0x${Buffer.from('TEST').toString('hex').padEnd(64, '0')}`,
  'name()': `0x${Buffer.from('Fixture Token').toString('hex').padEnd(64, '0')}`, 'decimals()': `0x${word(18)}` };
function rpcDouble({ receiptValue = receipt, overrides = {} } = {}) {
  const calls = [];
  return { calls, async request(method, params) { calls.push([method, params]); assert.equal(method, 'eth_getTransactionReceipt'); return receiptValue; },
    async batch(requests) { calls.push(...requests); return requests.map(([method, params]) => {
      if (method === 'eth_getCode') return { result: overrides.code ?? '0x6000' };
      const signature = Object.keys(values).find((name) => selectorOf(name) === params[0].data.slice(0, 10));
      if (!signature) return overrides.probe ?? { error: { code: 3, message: 'execution reverted' } };
      return { result: overrides[signature] ?? values[signature] };
    }); } };
}
// Batch answer index for a creation candidate without a launch source: 0 code, 1 totalSupply, 2 balanceOf, 6 negative control.
function withAnswers(answers, options) {
  const rpc = rpcDouble(options); const batch = rpc.batch.bind(rpc);
  rpc.batch = async (calls) => { const out = await batch(calls); for (const [index, answer] of Object.entries(answers)) out[index] = answer; return out; };
  return rpc;
}
const REVERT = { error: { code: 3, message: 'execution reverted' } };
const TRANSIENT = { error: { code: -32000, message: 'header not found' } };
const families = { usdc: { status: 'available' }, assets: { status: 'available' }, uniswapV3: { status: 'available' }, uniswapV4: { status: 'available' } };
const projections = { uniswap_v3_pools: { status: 'available' }, uniswap_v4_pools: { status: 'available' } };
const range = { hourStart: BASE, firstBlock: 100, lastBlock: 109, parentHash: hash(99), lastHash: hash(109) };
const finish = (sink, changes = {}) => sink.finish({ range, families, codePresent: () => true, projections, ...changes });
const block = { number: 101, hash: hash(101), timestamp: BASE + 10, txHashes: [hash(101)], txFrom: [DEPLOYER], txTo: [null] };
const window = new Map([[101, block]]);

await test('registry keeps official assets and tokenized fund provenance; only approved launches activated', () => {
  assert.equal(INTELLIGENCE_REGISTRY.assets.length, 5);
  assert.equal(INTELLIGENCE_REGISTRY.assets.find((asset) => asset.symbol === 'USYC').category, 'tokenized_fund');
  assert.equal(extensionStreams(INTELLIGENCE_REGISTRY).length, 4);
  assert.deepEqual(INTELLIGENCE_REGISTRY.launches.map(source => source.protocol).sort(), ['Archemist V2', 'Argus', 'Openlaunch', 'Tolly']);
  assert.equal(INTELLIGENCE_REGISTRY.exchanges.length, 0);
  assert.equal(INTELLIGENCE_REGISTRY.protocols.length, 0);
});
await test('registry requires chain, provenance, event fields and version; rejects duplicate case-insensitive addresses', () => {
  assert.throws(() => intelligenceRegistry({ exchanges: [{ ...regEntry, source: '' }] }), /registry/);
  assert.throws(() => intelligenceRegistry({ exchanges: [{ ...regEntry, chainId: 1 }] }), /registry/);
  assert.throws(() => intelligenceRegistry({ exchanges: [regEntry, { ...regEntry, address: SOURCE.toUpperCase().replace('0X', '0x') }] }), /duplicate/);
  assert.throws(() => intelligenceRegistry({ protocols: [{ ...regEntry, events: [{ declaration: 'event Flow(uint256 amount)' }] }] }), /definition/);
});
await test('candidate duplicates deterministic and bounded; partial never a full token universe', () => {
  const sink = createIntelligenceSink({ limit: 1 }); sink.blocks([block, block]);
  assert.equal(finish(sink).discovery.candidates.length, 1);
  sink.blocks([{ ...block, number: 102, txHashes: [hash(102)] }]);
  assert.equal(finish(sink).discovery.status, 'insufficient_coverage');
  assert.equal(finish(sink).discovery.allArcTokensComplete, false);
});
await test('valid token accepted with exact historical code/behavior and receipt identity', async () => {
  const provider = rpcDouble(); const result = await verifyTokenCandidate(provider, candidate);
  assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.address, TOKEN);
  assert.equal(result.symbol, 'TEST'); assert.equal(result.decimals, 18);
  assert.equal(result.launch.status, 'direct_deployment');
  for (const [method, params] of provider.calls) if (method !== 'eth_getTransactionReceipt') assert.equal(params.at(-1), '0x6d');
});
await test('non-token code and malformed or reverted required views resolve as rejected, never a token', async () => {
  for (const [provider, reason] of [[rpcDouble({ overrides: { code: '0x' } }), 'contract_code_absent'],
    [rpcDouble({ overrides: { 'totalSupply()': '0x' } }), 'required_token_views_rejected'],
    [rpcDouble({ overrides: { 'balanceOf(address)': '0x01' } }), 'required_token_views_rejected'],
    [withAnswers({ 1: REVERT }), 'required_token_views_rejected']]) {
    const result = await verifyTokenCandidate(provider, candidate);
    assert.equal(result.status, 'rejected_not_erc20_like'); assert.equal(result.reason, reason);
  }
});
await test('generic fallback returning a word for every selector is a resolved negative (negative control kept)', async () => {
  const result = await verifyTokenCandidate(rpcDouble({ overrides: { probe: { result: `0x${word(0)}` } } }), candidate);
  assert.equal(result.status, 'rejected_not_erc20_like'); assert.equal(result.reason, 'token_behavior_negative_control_failed');
  assert.equal(result.directDeploymentVerified, true); assert.equal(result.symbol, null);
  assert.equal((await verifyTokenCandidate(withAnswers({ 6: REVERT }), candidate)).status, 'verified_erc20_like');
});
await test('provider item errors and missing answers stay retryable, never a guessed rejection', async () => {
  for (const [answers, reason] of [[{ 0: TRANSIENT }, 'required_token_views_unavailable'], [{ 0: undefined }, 'required_token_views_unavailable'],
    [{ 1: TRANSIENT }, 'required_token_views_unavailable'], [{ 2: { result: null } }, 'required_token_views_unavailable'],
    [{ 6: TRANSIENT }, 'token_behavior_negative_control_unavailable'],
    // Fixed check order: an earlier transient answer decides, so a later revert cannot resolve on partial evidence.
    [{ 0: TRANSIENT, 1: REVERT }, 'required_token_views_unavailable']]) {
    const result = await verifyTokenCandidate(withAnswers(answers), candidate);
    assert.equal(result.status, 'unverified'); assert.equal(result.reason, reason);
  }
});
await test('malformed optional metadata preserves chain evidence, never fabricates fields', async () => {
  const result = await verifyTokenCandidate(rpcDouble({ overrides: { 'symbol()': '0xff', 'name()': '0x', 'decimals()': `0x${word(256)}` } }), candidate);
  assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.symbol, null); assert.equal(result.name, null);
  assert.equal(result.decimals, null); assert.equal(result.directDeploymentVerified, true);
});
await test('wrong block/hash/index or missing receipt stays retryable; an identical failed creation is rejected', async () => {
  for (const receiptValue of [null, { ...receipt, blockHash: hash(999) }, { ...receipt, transactionIndex: '0x1' },
    { ...receipt, status: '0x0', blockHash: hash(999) }, { ...receipt, contractAddress: null }]) {
    const result = await verifyTokenCandidate(rpcDouble({ receiptValue }), candidate);
    assert.equal(result.status, 'unverified'); assert.equal(result.reason, 'deployment_receipt_unverified');
  }
  const provider = rpcDouble({ receiptValue: { ...receipt, status: '0x0', contractAddress: null } });
  const failed = await verifyTokenCandidate(provider, candidate);
  assert.equal(failed.status, 'rejected_not_erc20_like'); assert.equal(failed.reason, 'deployment_failed');
  assert.equal(failed.directDeploymentVerified, false); assert.equal(provider.calls.length, 1);
});
await test('transient RPC errors remain sanitized unverified, never guessed rejection', async () => {
  const result = await verifyTokenCandidate({ request() { throw new Error('secret_rpc_body'); } }, candidate);
  assert.equal(result.status, 'unverified'); assert.equal(result.reason, 'candidate_rpc_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /secret_rpc_body/);
});
await test('pool-observed token has no invented deployment or launch source', async () => {
  const result = await verifyTokenCandidate(rpcDouble(), { ...candidate, kind: 'pool', address: TOKEN, deployer: null });
  assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.directDeploymentVerified, false);
  assert.equal(result.launch.status, 'unknown_source');
});
await test('verified launch source uses explicit historical code, event and registry version', async () => {
  const sink = createIntelligenceSink({ registry }); const stream = extensionStreams(registry).find((entry) => entry.kind === 'launch');
  const event = stream.entry.events[0].event;
  sink.extension(stream, [{ address: SOURCE, blockNumber: 101, logIndex: 2, transactionIndex: 0, transactionHash: hash(101),
    topics: [event.topic, `0x${word(TOKEN)}`], data: '0x' }], window);
  const observed = finish(sink).discovery.candidates[0]; assert.equal(observed.deployer, null);
  const result = await verifyTokenCandidate(rpcDouble(), observed, { registry });
  assert.equal(result.launch.status, 'verified_factory'); assert.equal(result.launch.provenance.source, 'synthetic_official_fixture');
  assert.equal(classifyLaunch({ ...result, launchEvidence: { ...result.launchEvidence, version: 'wrong' } }, registry).status, 'unknown_source');
});
await test('unavailable registered stream leaves discovery incomplete', () => {
  const sink = createIntelligenceSink({ registry }); sink.failExtension(extensionStreams(registry)[0]);
  assert.equal(finish(sink).discovery.status, 'insufficient_coverage');
});
await test('verified protocol event counts/raw per-asset sums, malformed event unavailable', () => {
  const sink = createIntelligenceSink({ registry }); const stream = extensionStreams(registry).find((entry) => entry.kind === 'protocol');
  const log = { address: SOURCE, blockNumber: 101, topics: [stream.entry.events[0].event.topic, `0x${word(TOKEN)}`], data: `0x${word(10n ** 40n)}` };
  sink.extension(stream, [log], window); const out = finish(sink).protocols[0];
  assert.equal(out.counts.supply, 1); assert.equal(out.rawFlows[`supply:${TOKEN}`], (10n ** 40n).toString());
  sink.extension(stream, [{ ...log, data: '0x01' }], window); assert.equal(finish(sink).protocols[0].rawFlows, null);
});
const transfer = defineEvent('event Transfer(address indexed from, address indexed to, uint256 amount)');
const usdc = INTELLIGENCE_REGISTRY.assets.find((asset) => asset.symbol === 'USDC');
const transferLog = (from, to, amount, emitter = USDC_SYSTEM_EMITTER.toLowerCase()) => ({ address: emitter, blockNumber: 101,
  topics: [transfer.topic, `0x${word(from)}`, `0x${word(to)}`], data: `0x${word(amount)}` });
await test('verified exchange inbound/outbound; unrelated address and USDC interface ignored', () => {
  const sink = createIntelligenceSink({ registry });
  sink.transfers([transferLog(TOKEN, EXCHANGE, 10n ** 18n), transferLog(EXCHANGE, TOKEN, 2n * 10n ** 18n),
    transferLog(EXCHANGE, EXCHANGE, 1n), transferLog(TOKEN, DEPLOYER, 10n), transferLog(TOKEN, EXCHANGE, 1000000n, usdc.address)]);
  const rows = finish(sink).exchange.rows; assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.direction, row.count, row.decimals]), [['inbound', 1, 18], ['outbound', 1, 18]]);
  assert.equal(valueExchangeFlow(rows[0], null).usd.usdMicros, '1000000');
});
await test('unverified exchange registry empty; incomplete transfers unavailable, never zero', () => {
  assert.equal(finish(createIntelligenceSink()).exchange.reason, 'verified_exchange_registry_empty');
  assert.equal(finish(createIntelligenceSink({ registry }), { families: { ...families, usdc: { status: 'unavailable' } } }).exchange.status, 'insufficient_coverage');
});
await test('exchange asset units and unavailable prices never mixed or fabricated', () => {
  const row = { entity: 'x', asset: TOKEN, emitter: TOKEN, direction: 'inbound', count: 1, decimals: 18, amountRaw: (10n ** 50n).toString() };
  assert.equal(valueExchangeFlow(row, null).usd.usdMicros, null);
  const rows = sumExchange([{ rows: [valueExchangeFlow(row, null), valueExchangeFlow({ ...row, asset: usdc.address,
    emitter: USDC_SYSTEM_EMITTER.toLowerCase(), amountRaw: '1000000000000000000' }, null)] }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].amountRaw, (10n ** 50n).toString()); assert.equal(rows[0].usd.status, 'unavailable');
});
await test('protocol versions never merged, different assets retain their raw identity', () => {
  const row = { id: 'x', version: 'v1', counts: { events: 1 }, rawFlows: { [`supply:${TOKEN}`]: (10n ** 40n).toString() } };
  const rows = sumProtocols([{ rows: [row, { ...row, version: 'v2' }] }]); assert.equal(rows.length, 2);
  assert.equal(rows[0].rawFlows[`supply:${TOKEN}`], (10n ** 40n).toString());
});
await test('DEX observation uses existing decoded V3/V4 events without another log request', () => {
  const sink = createIntelligenceSink();
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) sink.dex(protocol, 'swap', { address: TOKEN, blockNumber: 101,
    logIndex: 3, transactionHash: hash(101) }, { poolId: hash(80) }, window);
  const out = finish(sink); assert.equal(out.firstDex.length, 2); assert.equal(out.firstDexComplete, true);
  assert.equal(finish(sink, { projections: null }).firstDexComplete, false);
});

function hour(index = 0, { observation = true } = {}) {
  const hourStart = BASE + index * 3600; const firstBlock = 100 + index * 10; const lastBlock = firstBlock + 9;
  const sink = createIntelligenceSink(); if (observation && index === 0) sink.blocks([block]);
  const range = { kind: 'hour', hourStart, hourEnd: hourStart + 3600, firstBlock, lastBlock,
    parentHash: hash(firstBlock - 1), firstHash: hash(firstBlock), lastHash: hash(lastBlock) };
  return { definitionVersion: COMPACT_DEFINITION_VERSION, sourceVersions: {}, chainId: 5042, range,
    network: { status: 'available', blockCount: 10, transactionCount: 1, uniqueActiveAddresses: 0 }, activeAddresses: [],
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture',
      ...Object.fromEntries(fields.map((field) => [field, null])) }])), registry: { uniswapV3: null }, complete: false,
    // Generic discovery uses the helper's available family/projection evidence and isolated discoveryRegistry.
    intelligence: finish(sink, { range }) };
}
function fixture() { const db = new DatabaseSync(':memory:'); const store = createCompactStore(db); return { db, store }; }
await test('schema2 additive migration idempotent; empty/old new-layer state unavailable', () => {
  const { db, store } = fixture(); createCompactStore(db); store.commitHour(hour());
  assert.equal(db.prepare("SELECT value FROM compact_meta WHERE key='schema_version'").get().value, '2');
  assert.equal(readEcosystem(db, '24h').coverage.status, 'insufficient_coverage'); db.close();
});
await test('hour candidate transaction atomic, crash hook rolls back all new rows/checkpoint', () => {
  const { db, store } = fixture();
  assert.throws(() => store.commitHour(hour(), { beforeCommit() { throw new Error('crash'); } }), /crash/);
  for (const table of ['compact_hours', 'compact_intelligence_hours', 'compact_token_discoveries']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(store.checkpoint(), null); db.close();
});
await test('candidate replay idempotent, durable pending survives repository restart and retry cooldown', async () => {
  const { db, store } = fixture(); store.commitHour(hour()); store.commitHour(hour()); const restarted = createCompactStore(db);
  assert.equal(restarted.intelligence.pending({ now: 100, limit: 16 }).length, 1);
  restarted.intelligence.recordVerification({ ...candidate, status: 'unverified', reason: 'candidate_rpc_unavailable' }, { now: 100 });
  assert.equal(restarted.intelligence.pending({ now: 101, limit: 16 }).length, 0);
  assert.equal(restarted.intelligence.pending({ now: 3600100, limit: 16 }).length, 1);
  const provider = rpcDouble(); const report = await refreshDiscovery({ store: restarted, provider, now: 3600100 });
  assert.equal(report.verified, 1); assert.equal(restarted.intelligence.pending({ now: 7200200, limit: 16 }).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compact_token_discoveries').get().n, 1); db.close();
});
await test('historical prepend and replay never change live checkpoint; candidates recovered after restart', () => {
  const { db, store } = fixture(); store.commitHour(hour(1)); const checkpoint = store.checkpoint();
  store.commitHistoricalHour(hour(0)); store.commitHistoricalHour(hour(0));
  assert.deepEqual(store.checkpoint(), checkpoint); assert.equal(createCompactStore(db).intelligence.pending({ now: 100, limit: 16 }).length, 1); db.close();
});
// Multiple durable creation identities in the same canonical hour, no manufactured live token evidence.
function candidateHour(count) {
  const row = hour(0, { observation: false }); const sink = createIntelligenceSink();
  sink.blocks([{ ...block, txHashes: Array.from({ length: count }, (_, i) => hash(1100 + i)),
    txFrom: Array(count).fill(DEPLOYER), txTo: Array(count).fill(null) }]);
  row.intelligence = finish(sink, { range: row.range }); row.network.transactionCount = count;
  return row;
}
function queueFixture(count) {
  const out = fixture(); out.store.commitHour(candidateHour(count));
  const items = out.db.prepare('SELECT candidate_json FROM compact_token_discoveries ORDER BY candidate_key').all()
    .map(row => JSON.parse(row.candidate_json));
  return { ...out, items };
}
const retry = (store, item, now) => store.intelligence.recordVerification({ ...item, status: 'unverified', reason: 'candidate_rpc_unavailable' }, { now });
await test('historical COMMIT precedes bounded targeted refresh outside transaction, with checkpoint unchanged', async () => {
  const { db, store } = fixture(); store.commitHour(hour(1)); const before = store.checkpoint();
  store.commitHistoricalHour(hour(0));
  const provider = rpcDouble();
  for (const method of ['request', 'batch']) {
    const call = provider[method].bind(provider);
    provider[method] = (...args) => { assert.equal(db.isTransaction, false); return call(...args); };
  }
  assert.deepEqual(await refreshDiscoverySafely({ store, provider, now: 100 }),
    { status: 'available', candidates: 1, verified: 1, rejected: 0, unresolved: 0 });
  assert.deepEqual(store.checkpoint(), before); assert.equal(store.hourCount(), 2); db.close();
});
await test('post-commit refresh persistence failure cannot undo hour; durable candidate retries after restart', async () => {
  const { db, store } = fixture(); store.commitHour(hour(1)); const checkpoint = store.checkpoint(); store.commitHistoricalHour(hour(0));
  const failingStore = { intelligence: { pending: options => store.intelligence.pending(options),
    recordVerification() { throw new Error('private_db_error'); } } };
  assert.deepEqual(await refreshDiscoverySafely({ store: failingStore, provider: rpcDouble(), now: 100 }),
    { status: 'unavailable', reason: 'discovery_refresh_unavailable' });
  assert.equal(store.hourCount(), 2); assert.deepEqual(store.checkpoint(), checkpoint);
  const restarted = createCompactStore(db);
  assert.equal(restarted.intelligence.pending({ now: 100, limit: 16 }).length, 1);
  assert.equal((await refreshDiscoverySafely({ store: restarted, provider: rpcDouble(), now: 100 })).verified, 1); db.close();
});
await test('historical child wiring invokes enrichment after COMMIT at most once, including --all', () => {
  const source = readFileSync(new URL('./backfill-compact-history.mjs', import.meta.url), 'utf8');
  const execution = source.slice(source.indexOf('export async function executeHistoryBackfill'));
  assert(execution.indexOf('store.commitHistoricalHour(') < execution.indexOf('await refreshDiscoverySafely('));
  assert.match(execution, /if \(!discoveryRefreshed\) \{\s*discoveryRefreshed = true;/);
  assert.equal((execution.match(/await refreshDiscoverySafely\(/g) ?? []).length, 1);
  assert.match(execution, /finally \{\s*db\?\.close\(\);\s*lock.release\(\)/);
});
await test('fair pass reserves eight places each for fresh and due retry at unchanged cap sixteen', () => {
  const { db, store, items } = queueFixture(48);
  for (const item of items.slice(0, 24)) retry(store, item, 100);
  const selected = store.intelligence.pending({ now: 3600100, limit: 16 });
  assert.equal(selected.length, 16);
  assert.deepEqual(selected.slice(0, 8).map(item => item.key), items.slice(0, 8).map(item => item.key));
  assert.deepEqual(selected.slice(8).map(item => item.key), items.slice(24, 32).map(item => item.key)); db.close();
});
await test('unused quotas borrowed from either queue; cooldown retries and terminal negatives excluded', () => {
  const { db, store, items } = queueFixture(40);
  assert.equal(store.intelligence.pending({ now: 100, limit: 16 }).length, 16);
  for (const item of items.slice(0, 38)) retry(store, item, 100);
  assert.equal(store.intelligence.pending({ now: 101, limit: 16 }).length, 2);
  const selected = store.intelligence.pending({ now: 3600100, limit: 16 });
  assert.equal(selected.length, 16); assert(selected.some(item => item.key === items[39].key));
  for (const item of items.slice(38)) retry(store, item, 100);
  assert.equal(store.intelligence.pending({ now: 3600100, limit: 16 }).length, 16);
  for (const item of items) store.intelligence.recordVerification({ ...item, status: 'rejected_not_erc20_like', reason: 'deployment_failed' }, { now: 3600100 });
  assert.equal(discoveryWorkDue(db, 10 ** 12), false); assert.deepEqual(store.intelligence.pending({ now: 10 ** 12, limit: 16 }), []); db.close();
});
await test('continuous fresh backlog cannot starve due retries; cooldown ordering rotates retry identities', () => {
  const { db, store, items } = queueFixture(80);
  for (const item of items.slice(0, 16)) retry(store, item, 100);
  const first = store.intelligence.pending({ now: 3600100, limit: 16 });
  for (const item of first) retry(store, item, 3600100);
  const second = store.intelligence.pending({ now: 3600101, limit: 16 });
  assert.deepEqual(second.slice(0, 8).map(item => item.key), items.slice(8, 16).map(item => item.key));
  assert.deepEqual(second.slice(8).map(item => item.key), items.slice(24, 32).map(item => item.key));
  for (const item of second) retry(store, item, 3600101);
  const third = store.intelligence.pending({ now: 7200100, limit: 16 });
  assert.deepEqual(third.slice(0, 8).map(item => item.key), items.slice(0, 8).map(item => item.key)); db.close();
});
await test('verified source unknown-source alone remains due retry eligible; pool/direct tokens stay terminal', async () => {
  const { db, store } = fixture(); const row = hour(0, { observation: false }); const sink = createIntelligenceSink({ registry });
  const stream = extensionStreams(registry).find(entry => entry.kind === 'launch');
  sink.extension(stream, [{ address: SOURCE, blockNumber: 101, logIndex: 2, transactionIndex: 0, transactionHash: hash(101),
    topics: [stream.entry.events[0].event.topic, `0x${word(TOKEN)}`], data: '0x' }], window);
  row.intelligence = finish(sink, { range: row.range }); store.commitHour(row);
  const [item] = store.intelligence.pending({ now: 100, limit: 16 });
  const result = await verifyTokenCandidate(rpcDouble(), item, { registry });
  store.intelligence.recordVerification({ ...result, launch: { status: 'unknown_source' } }, { now: 100 });
  assert.equal(discoveryWorkDue(db, 101), false); assert.equal(discoveryWorkDue(db, 3600100), true);
  assert.deepEqual(store.intelligence.pending({ now: 3600100, limit: 16 }).map(row => row.key), [item.key]);
  store.intelligence.recordVerification(result, { now: 3600100 });
  assert.equal(discoveryWorkDue(db, 10 ** 12), false); db.close();
});
await test('drain is capped at sixteen, targeted only, preserves checkpoint/family/projection rows after restart', async () => {
  const { db, store, items } = queueFixture(40); const before = store.checkpoint();
  const tables = ['compact_hours', 'compact_family_hours', 'compact_projection_hours', 'compact_registry', 'compact_registry_coverage', 'compact_intelligence_hours'];
  const durable = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
  const facts = durable(); const provider = rpcDouble();
  provider.request = async (method, params) => {
    assert.equal(db.isTransaction, false); assert.equal(method, 'eth_getTransactionReceipt'); provider.calls.push([method, params]);
    const item = items.find(item => item.txHash === params[0]); assert(item);
    return { ...receipt, transactionHash: item.txHash, transactionIndex: `0x${item.transactionIndex.toString(16)}` };
  };
  const report = await drainDiscovery({ store, provider, now: 100 });
  assert.equal(report.candidates, 16); assert.equal(report.verified, 16); assert.equal(report.status, 'available');
  assert.deepEqual(store.checkpoint(), before); assert.deepEqual(durable(), facts);
  assert.equal(provider.calls.filter(([method]) => method === 'eth_getTransactionReceipt').length, 16);
  assert(provider.calls.every(([method]) => ['eth_getTransactionReceipt', 'eth_getCode', 'eth_call'].includes(method)));
  const restarted = createCompactStore(db);
  assert.equal((await drainDiscovery({ store: restarted, provider, now: 101 })).verified, 16);
  assert.deepEqual(store.checkpoint(), before); assert.deepEqual(durable(), facts); db.close();
});
await test('drain unresolved evidence persists with cooldown and sanitizes refresh failure', async () => {
  const { db, store } = fixture(); store.commitHour(hour());
  const report = await drainDiscovery({ store, provider: withAnswers({ 1: TRANSIENT }), now: 100 });
  assert.equal(report.unresolved, 1); assert.equal(discoveryWorkDue(db, 101), false);
  assert.equal(discoveryWorkDue(db, 3600100), true);
  const failing = { checkpoint: () => store.checkpoint(), intelligence: { pending() { throw new Error('secret'); } } };
  assert.deepEqual(await drainDiscovery({ store: failing, provider: rpcDouble(), now: 100 }),
    { status: 'unavailable', reason: 'discovery_refresh_unavailable' }); db.close();
});
await test('drain cannot bootstrap absent checkpoint or accept scan arguments/unsafe pacing', async () => {
  const { db, store } = fixture(); const provider = rpcDouble();
  assert.equal((await drainDiscovery({ store, provider, now: 100 })).reason, 'discovery_checkpoint_missing'); assert.equal(provider.calls.length, 0);
  assert.throws(() => discoveryDrainConfig({ argv: ['--all'], env: { COMPACT_SQLITE_PATH: '/fixture.db' } }), /arguments_not_allowed/);
  assert.throws(() => discoveryDrainConfig({ argv: [], env: { COMPACT_SQLITE_PATH: '/fixture.db', COMPACT_RPC_MIN_INTERVAL_MS: '1' } }), /unsafe_rpc_pacing/);
  assert.equal(discoveryWorkDue(db, 100), false); db.close();
});
await test('discovery-only child keeps writer ownership and forbids range replay by construction', () => {
  const source = readFileSync(new URL('./drain-compact-discovery.mjs', import.meta.url), 'utf8');
  assert.match(source, /lock = acquireWriterLock\(sqlitePath, \{ owner: 'discovery-drain' \}\)/);
  assert.match(source, /finally \{ db\?\.close\(\); lock\?\.release\(\); \}/);
  assert.doesNotMatch(source, /processHour|processBlockRange|eth_getLogs|eth_getBlockByNumber|commitHour|commitHistoricalHour/);
});
await test('drain refuses changed checkpoint hash, never reporting successful enrichment as checkpoint safety', async () => {
  let reads = 0;
  const store = { checkpoint: () => ({ hourStart: BASE, lastBlock: 109, lastHash: hash(reads++ ? 999 : 109) }),
    intelligence: { pending: () => [] } };
  assert.deepEqual(await drainDiscovery({ store, provider: rpcDouble(), now: 100 }),
    { status: 'unavailable', reason: 'discovery_checkpoint_changed' });
});
await test('all legacy stored hours without discovery stay insufficient for 24h/7d/30d; DEX registry never upgrades this', () => {
  const { db, store } = fixture();
  for (let i = 0; i < 720; i++) {
    const row = hour(i); row.network.internal = { deploymentAttempts: i % 2 ? 0 : 7 };
    delete row.intelligence; store.commitHour(row);
  }
  db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)').run('uniswap_v3_pool', address(20), 102n, 0n, hash(102), JSON.stringify({ token0: TOKEN, token1: usdc.address }));
  for (const kind of ['uniswap_v3_pool', 'uniswap_v4_pool']) db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)').run(kind, 0n, 7299n, hash(7299));
  const dex = correlateDex(db, TOKEN, 7299);
  assert.equal(dex.status, 'available'); assert.equal(dex.firstPool.pool, address(20));
  assert.equal(dex.firstPool.firstSwap.status, 'unavailable'); assert.equal(dex.firstPool.firstSwap.reason, 'activity_not_stored');
  assert.equal(dex.firstDexActivity.value, null); assert.equal(dex.firstDexActivity.firstObserved, null);
  for (const name of ['24h', '7d', '30d']) {
    const data = readEcosystem(db, name);
    assert.equal(data.coverage.availableHours, 0); assert.equal(data.coverage.status, 'insufficient_coverage');
    assert.equal(data.coverage.candidateVerificationComplete, false); assert.equal(data.discoveredTokens.status, 'insufficient_coverage');
    assert.equal(data.launches.status, 'insufficient_coverage'); assert.deepEqual(data.discoveredTokens.rows, []);
  }
  assert.equal(store.intelligence.pending({ now: 100, limit: 16 }).length, 0); db.close();
});
await test('unresolved outside selected 24h window does not change current scoped candidate verification', () => {
  const { db, store } = fixture(); for (let i = 0; i <= 24; i++) store.commitHour(hour(i));
  assert.deepEqual(db.prepare('SELECT DISTINCT registry_digest FROM compact_intelligence_hours').all().map(row => row.registry_digest),
    [registryDigest(discoveryRegistry)]);
  const day = readEcosystem(db, '24h'); assert.equal(day.coverage.unresolvedCandidateCount, 0);
  assert.equal(day.coverage.requiredHours, 24); assert.equal(day.coverage.availableHours, 24);
  assert.equal(day.coverage.candidateVerificationComplete, true);
  assert.equal(readEcosystem(db, '7d').coverage.candidateVerificationComplete, false); db.close();
});

await test('30D ecosystem reads the verified stored interval without pretending discovery is complete', () => {
  const { db, store } = fixture();
  try {
    for (let i = 0; i < 49; i++) store.commitHour(hour(i));
    const before = db.prepare('SELECT * FROM compact_checkpoint').get();
    const data = readEcosystem(db, '30d');
    assert.equal(data.window.hours, 720);
    assert.equal(data.window.coverage.status, 'partial');
    assert.equal(data.window.coverage.availableHours, 49);
    assert.equal(data.coverage.requiredHours, 49, 'layer verification is scoped to actual stored hours');
    assert.equal(data.coverage.availableHours, 49);
    assert.equal(data.coverage.status, 'available');
    assert.equal(data.coverage.candidateVerificationComplete, false, 'unresolved tokens remain unverified');
    assert.equal(data.discoveredTokens.status, 'insufficient_coverage');
    assert.equal(data.launches.status, 'insufficient_coverage');
    assert.equal(readEcosystem(db, '7d').coverage.status, 'insufficient_coverage');
    assert.deepEqual(db.prepare('SELECT * FROM compact_checkpoint').get(), before);
  } finally { db.close(); }
});
await test('canonical candidate mismatch rolls back without destroying accepted hour', () => {
  const { db, store } = fixture(); store.commitHour(hour()); const bad = hour();
  bad.intelligence = { ...bad.intelligence, range: { ...bad.intelligence.range, lastHash: hash(999) } };
  assert.notEqual(bad.intelligence.range, bad.range); assert.equal(bad.range.lastHash, hash(109));
  assert.throws(() => store.commitHour(bad), /range_mismatch/); assert.equal(store.hourCount(), 1); db.close();
});
await test('read model keeps missing hours as gaps and provenance distinct from token discovery', () => {
  const { db, store } = fixture(); store.commitHour(hour());
  const data = readEcosystem(db, '24h'); assert.equal(data.coverage.availableHours, 1); assert.equal(data.coverage.requiredHours, 24);
  assert.equal(data.discoveredTokens.rows.length, 0); assert.equal(data.contractCandidates.rows[0].verifiedAsset, false);
  assert.equal(data.exchangeFlows.reason, 'verified_exchange_registry_empty');
  assert.equal(data.otherProtocols.reason, 'verified_protocol_registry_empty'); assert.equal(data.rwa[0].symbol, 'USYC'); db.close();
});
await test('24 complete discovery hours yield scoped coverage, not all-Arc-token universe completeness', () => {
  const { db, store } = fixture(); for (let i = 0; i < 24; i++) store.commitHour(hour(i));
  const data = readEcosystem(db, '24h'); assert.equal(data.coverage.status, 'available'); assert.equal(data.coverage.allArcTokensComplete, false);
  assert.equal(data.exchangeFlows.status, 'unavailable'); db.close();
});
// 24 covered hours; hour 0 holds the single top-level creation candidate.
function fullDay() { const out = fixture(); for (let i = 0; i < 24; i++) out.store.commitHour(hour(i)); return out; }
await test('resolved negative is terminal: never re-read, not unresolved, never a token, launch or verified asset', async () => {
  const { db, store } = fullDay(); const generic = rpcDouble({ overrides: { probe: { result: `0x${word(0)}` } } });
  assert.deepEqual(await refreshDiscovery({ store, provider: generic, now: 100 }), { candidates: 1, verified: 0, rejected: 1, unresolved: 0 });
  const before = db.prepare('SELECT * FROM compact_token_discoveries').get();
  assert.equal(before.status, 'rejected_not_erc20_like'); assert.equal(before.reason, 'token_behavior_negative_control_failed');
  for (const now of [100, 3600100, 10 ** 12]) assert.equal(store.intelligence.pending({ now, limit: 16 }).length, 0);
  const calls = generic.calls.length;
  assert.equal((await refreshDiscovery({ store, provider: generic, now: 10 ** 12 })).candidates, 0); assert.equal(generic.calls.length, calls);
  // Replayed hour evidence or a contradicting later answer never reopens, promotes or re-counts the resolved candidate.
  store.commitHistoricalHour(hour(0));
  store.intelligence.recordVerification(await verifyTokenCandidate(rpcDouble(), candidate), { now: 10 ** 12 });
  assert.deepEqual(db.prepare('SELECT * FROM compact_token_discoveries').get(), before);
  const data = readEcosystem(db, '24h');
  assert.equal(data.coverage.unresolvedCandidateCount, 0); assert.equal(data.coverage.candidateVerificationComplete, true);
  assert.equal(data.discoveredTokens.status, 'available'); assert.equal(data.discoveredTokens.rows.length, 0);
  assert.equal(data.launches.status, 'available'); assert.equal(data.launches.rows.length, 0);
  assert.equal(data.contractCandidates.status, 'available'); const [row] = data.contractCandidates.rows;
  assert.equal(row.address, TOKEN); assert.equal(row.status, 'rejected_not_erc20_like'); assert.equal(row.verifiedAsset, false);
  assert.equal(row.launch.status, 'not_applicable'); assert.equal(row.dex.reason, 'rejected_not_erc20_like');
  assert.equal(data.verifiedAssets.some((asset) => asset.address === TOKEN), false); db.close();
});
await test('transient failure stays retryable and unresolved; verification and launches fail closed until resolved', async () => {
  const { db, store } = fullDay();
  const fresh = readEcosystem(db, '24h'); assert.equal(fresh.coverage.status, 'available');
  assert.equal(fresh.coverage.unresolvedCandidateCount, 1); assert.equal(fresh.launches.status, 'insufficient_coverage');
  assert.deepEqual(await refreshDiscovery({ store, provider: withAnswers({ 1: TRANSIENT }), now: 100 }),
    { candidates: 1, verified: 0, rejected: 0, unresolved: 1 });
  assert.equal(db.prepare('SELECT status FROM compact_token_discoveries').get().status, 'unverified');
  const data = readEcosystem(db, '24h');
  assert.equal(data.coverage.unresolvedCandidateCount, 1); assert.equal(data.coverage.candidateVerificationComplete, false);
  assert.equal(data.discoveredTokens.status, 'insufficient_coverage'); assert.equal(data.launches.status, 'insufficient_coverage');
  assert.equal(data.launches.rows.length, 0); assert.equal(data.contractCandidates.status, 'unverified');
  assert.equal(data.contractCandidates.rows[0].launch.status, 'unverified'); assert.equal(data.contractCandidates.rows[0].dex.reason, 'token_unverified');
  // Bounded retry: per-run read cap and cooldown, then eligible again.
  assert.equal(store.intelligence.pending({ now: 101, limit: 16 }).length, 0);
  assert.equal(store.intelligence.pending({ now: 3600100, limit: 16 }).length, 1);
  assert.deepEqual(await refreshDiscovery({ store, provider: rpcDouble(), now: 3600100 }), { candidates: 1, verified: 1, rejected: 0, unresolved: 0 });
  const resolved = readEcosystem(db, '24h');
  assert.equal(resolved.coverage.candidateVerificationComplete, true); assert.equal(resolved.launches.status, 'available');
  assert.deepEqual(resolved.launches.rows.map((row) => [row.address, row.launch.status]), [[TOKEN, 'direct_deployment']]);
  assert.deepEqual(resolved.discoveredTokens.rows.map((row) => row.address), [TOKEN]);
  assert.equal(resolved.verifiedAssets.some((asset) => asset.address === TOKEN), false); db.close();
});
await test('rejected source candidate never re-enters the launch-provenance retry branch', async () => {
  const { db, store } = fixture(); const row = hour(0, { observation: false });
  const sink = createIntelligenceSink({ registry }); const stream = extensionStreams(registry).find((entry) => entry.kind === 'launch');
  sink.extension(stream, [{ address: SOURCE, blockNumber: 101, logIndex: 2, transactionIndex: 0, transactionHash: hash(101),
    topics: [stream.entry.events[0].event.topic, `0x${word(TOKEN)}`], data: '0x' }], window);
  row.intelligence = finish(sink, { range: row.range }); store.commitHour(row);
  const [observed] = store.intelligence.pending({ now: 100, limit: 16 }); assert.equal(observed.kind, 'source');
  const result = await verifyTokenCandidate(rpcDouble({ overrides: { probe: { result: `0x${word(1)}` } } }), observed, { registry });
  assert.equal(result.status, 'rejected_not_erc20_like'); assert.equal(result.launch.status, 'unknown_source');
  store.intelligence.recordVerification(result, { now: 100 });
  assert.equal(store.intelligence.pending({ now: 10 ** 12, limit: 16 }).length, 0); db.close();
});
await test('first V3/V4 pool requires both factory histories; earliest swap stays first-observed across gaps', () => {
  const { db, store } = fixture(); store.commitHour(hour());
  for (const [kind, pool, created, floor] of [['uniswap_v3_pool', address(20), 102, 1948019], ['uniswap_v4_pool', hash(21), 103, 1948056]]) {
    db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)').run(kind, pool, BigInt(created), 0n, hash(created),
      JSON.stringify(kind.includes('v3') ? { token0: TOKEN, token1: usdc.address } : { currency0: TOKEN, currency1: address(0) }));
    db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)').run(kind, 0n, 109n, hash(109));
    db.prepare('INSERT INTO compact_token_dex_observations VALUES(?,?,?,?,?,?,?,?)').run(BigInt(BASE), kind.includes('v3') ? 'uniswap_v3' : 'uniswap_v4',
      pool, 'swap', 105n, 0n, BigInt(BASE + 30), hash(105));
  }
  const data = correlateDex(db, TOKEN, 109); assert.equal(data.firstPool.protocol, 'uniswap_v3');
  assert.equal(data.observedPools[1].protocol, 'uniswap_v4'); assert.equal(data.firstPool.firstSwap.firstProven, false);
  db.prepare("UPDATE compact_registry_coverage SET from_block=3000000 WHERE kind='uniswap_v4_pool'").run();
  assert.equal(correlateDex(db, TOKEN, 109).firstPool, null); db.close();
});
await test('new layer is read-only, GET proxy matrix bounded with old routes unaffected', async () => {
  for (const window of ['24h', '7d', '30d']) assert.equal(resolveIntelligenceRoute({ view: 'ecosystem', window }).path, `/v1/intelligence/ecosystem?window=${window}`);
  for (const query of [{ view: 'ecosystem', window: '1h' }, { view: 'ecosystem', window: ['24h'] }, { view: 'ecosystem', window: '24h', address: TOKEN }]) {
    assert.equal(resolveIntelligenceRoute(query), null);
  }
  assert.equal(resolveIntelligenceRoute({ view: 'summary', window: '24h' }).path, '/v1/intelligence/summary?window=24h');
  let response;
  await handleIntelligenceProxy({ method: 'GET', query: { view: 'ecosystem', window: '24h' }, env: {}, send(value) { response = value; },
    fetchImpl: async () => ({ status: 200, headers: { get() { return null; } }, text: async () => JSON.stringify({ schema: 'wrong' }) }) });
  assert.equal(response.status, 502);
});
await test('new asset/RWA and multiple official emitters fit explicit registries without promotion', () => {
  const expanded = intelligenceRegistry({ launches: [], assets: [...discoveryRegistry.assets, { chainId: 5042, address: TOKEN, symbol: 'FIXTURE', decimals: 8,
    category: 'rwa', verification: { type: 'synthetic_official_fixture', source: 'fixture_only_not_a_live_asset' } }],
    protocols: [{ ...regEntry, addresses: [SOURCE, address(903)], events: [{ declaration: 'event Counted(uint256 amount)', metric: 'events', aggregation: 'count' }] }] });
  const streams = extensionStreams(expanded);
  assert.equal(expanded.assets.length, 6); assert.equal(expanded.launches.length, 0); assert.equal(streams.length, 1);
  assert.equal(streams[0].kind, 'protocol'); assert.equal(streams[0].entry.id, regEntry.id);
  assert.equal(streams[0].address.length, 2); assert.deepEqual(streams[0].address, [SOURCE, address(903)]);
  assert.throws(() => intelligenceRegistry({ exchanges: [{ ...regEntry, address: EXCHANGE }, { ...regEntry, address: address(904), version: 'other' }] }), /mixed/);
});
await test('source code failure retains a verified token but does not invent launch provenance', async () => {
  const observed = { ...candidate, kind: 'source', address: TOKEN, deployer: null,
    launchEvidence: { emitter: SOURCE, version: 'fixture-v1', eventSignature: registry.launches[0].events[0].event.signature, codeVerified: false } };
  const rpc = rpcDouble(); const batch = rpc.batch.bind(rpc);
  rpc.batch = async (calls) => { const values = await batch(calls); values[6] = { error: { code: -1 } }; return values; };
  const result = await verifyTokenCandidate(rpc, observed, { registry });
  assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.launch.status, 'unknown_source');
});
await test('pool candidate reuses registry identity and cannot become direct deployment', async () => {
  const sink = createIntelligenceSink(); sink.poolCreated({ address: address(777), token0: TOKEN, token1: usdc.address,
    createdBlock: 101, createdLogIndex: 3, createdTx: hash(101) }, window);
  const observed = finish(sink).discovery.candidates[0]; assert.equal(observed.kind, 'pool'); assert.equal(observed.deployer, null);
  const result = await verifyTokenCandidate(rpcDouble(), observed); assert.equal(result.launch.status, 'unknown_source');
});
await test('same hour weaker evidence cannot erase certified discovery facts', () => {
  const { db, store } = fixture(); store.commitHour(hour());
  const before = db.prepare('SELECT evidence_digest FROM compact_intelligence_hours').get().evidence_digest;
  const weaker = hour(); weaker.intelligence.discovery.status = 'insufficient_coverage'; weaker.intelligence.discovery.reason = 'candidate_limit';
  weaker.intelligence.discovery.candidates = [];
  store.commitHour(weaker);
  assert.equal(db.prepare('SELECT evidence_digest FROM compact_intelligence_hours').get().evidence_digest, before);
  assert.equal(store.intelligence.pending({ now: 100, limit: 16 }).length, 1); db.close();
});
await test('changed certified candidate truth fails closed and preserves durable evidence', () => {
  const { db, store } = fixture(); store.commitHour(hour()); const changed = hour();
  changed.intelligence.discovery.candidates[0].blockHash = hash(888);
  assert.throws(() => store.commitHour(changed), /evidence_conflict/);
  assert.equal(JSON.parse(db.prepare('SELECT candidate_json FROM compact_token_discoveries').get().candidate_json).blockHash, hash(101)); db.close();
});
await test('first V4 pool selection and full first-swap coverage need actual stored observation history', () => {
  const { db, store } = fixture(); store.commitHour(hour());
  db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)').run('uniswap_v4_pool', hash(30), 102n, 0n, hash(102), JSON.stringify({ currency0: TOKEN, currency1: address(0) }));
  for (const kind of ['uniswap_v3_pool','uniswap_v4_pool']) db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)').run(kind, 0n, 109n, hash(109));
  db.prepare('INSERT INTO compact_token_dex_observations VALUES(?,?,?,?,?,?,?,?)').run(BigInt(BASE), 'uniswap_v4', hash(30), 'swap', 105n, 0n, BigInt(BASE+30), hash(105));
  db.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)').run(BigInt(BASE), 'uniswap_v4_pools', 'available', null, 1n, 'fixture');
  db.prepare("UPDATE compact_intelligence_hours SET payload_json=json_set(payload_json,'$.firstDexComplete',json('true'))").run();
  const dex = correlateDex(db, TOKEN, 109); assert.equal(dex.firstPool.protocol, 'uniswap_v4'); assert.equal(dex.firstPool.firstSwap.firstProven, true);
  db.prepare("UPDATE compact_projection_hours SET status='unavailable',reason='fixture',row_count=NULL,rows_sha256=NULL").run();
  assert.equal(correlateDex(db, TOKEN, 109).firstPool.firstSwap.firstProven, false); db.close();
});
await test('response and retry limits fail closed without RPC requests or zero-fill', () => {
  const { db, store } = fixture(); store.commitHour(hour());
  assert.throws(() => store.intelligence.pending({ now: 100, limit: 17 }), /limit/);
  db.prepare('UPDATE compact_intelligence_hours SET payload_json=?').run(JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }));
  assert.equal(readEcosystem(db,'24h').coverage.reason, 'bounded_read_limit'); db.close();
});
await test('old compact database without additive tables remains a valid not-stored read source', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE compact_checkpoint(id INTEGER,hour_start INTEGER,last_block INTEGER)');
  db.prepare('INSERT INTO compact_checkpoint VALUES(1,?,109)').run(BigInt(BASE));
  assert.equal(readEcosystem(db,'24h').coverage.reason, 'not_stored'); db.close();
});
await test('new proxy forwards genuine ecosystem schema and rejects arbitrary SQL/RPC parameters', async () => {
  const { db, store } = fixture(); store.commitHour(hour()); const payload = readEcosystem(db,'24h'); let response; let requested;
  await handleIntelligenceProxy({ method: 'GET', query: { view: 'ecosystem', window: '24h' }, env: {}, send(value) { response=value; },
    fetchImpl: async (url) => { requested=url; return { status: 200, headers: { get() { return null; } }, text: async () => JSON.stringify(payload) }; } });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).schema, ECOSYSTEM_SCHEMA);
  assert.equal(new URL(requested).pathname, '/v1/intelligence/ecosystem');
  assert.equal(resolveIntelligenceRoute({ view: 'ecosystem', window: '24h', blockTag: 'latest' }), null); db.close();
});
await test('processor uses identical generic observations across spine window sizes with no receipt RPC', async () => {
  const origin = 23000000;
  const run = async (windowBlocks) => {
    const chain = createSyntheticChain({ originNumber: origin, poolCreatedAt: origin, protocols: false });
    const provider = createProvider({ fetchImpl: chain.fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
    const result = await processBlockRange({ provider, first: origin, last: origin + 99,
      before: headerOf(chain.rawBlock(origin - 1), origin - 1), windowBlocks, intelligenceRegistry: discoveryRegistry,
      v3Registry: { through: origin - 1, throughHash: chain.blockHash(origin - 1), pools: new Set() } });
    assert.equal(provider.stats.calls.eth_getTransactionReceipt ?? 0, 0);
    return result;
  };
  const first = await run(50); const second = await run(100);
  assert.deepEqual(first.intelligence, second.intelligence); assert.deepEqual(first.network, second.network);
  assert.deepEqual(first.families, second.families); assert.deepEqual(first.projections, second.projections);
});
await test('hourly exchange summaries/timeseries and protocol sums require every hour, with exact raw units', () => {
  const { db, store } = fixture();
  for (let index = 0; index < 24; index++) {
    const row = hour(index, { observation: false }); const sink = createIntelligenceSink({ registry });
    sink.transfers([{ ...transferLog(TOKEN, EXCHANGE, 10n ** 18n), blockNumber: row.range.firstBlock }]);
    row.intelligence = finish(sink, { range: row.range }); store.commitHour(row);
  }
  const data = readEcosystem(db,'24h',{registry});
  assert.equal(data.exchangeFlows.status, 'available'); assert.equal(data.exchangeFlows.buckets.length, 24);
  assert.equal(data.exchangeFlows.rows[0].count, 24); assert.equal(data.exchangeFlows.rows[0].amountRaw, (24n * 10n ** 18n).toString());
  assert.equal(data.exchangeFlows.rows[0].usd.usdMicros, '24000000'); assert.equal(data.otherProtocols.rows[0].counts.supply, 0);
  db.prepare('UPDATE compact_intelligence_hours SET payload_json=json_set(payload_json,\'$.exchange.status\',\'unavailable\') WHERE hour_start=?').run(BigInt(BASE));
  const weaker = readEcosystem(db,'24h',{registry}); assert.equal(weaker.exchangeFlows.status,'unavailable'); assert.equal(weaker.exchangeFlows.rows,null); db.close();
});
await test('registry valid-from and USD raw-decimal mismatch fail closed', () => {
  const future = intelligenceRegistry({ launches: [], exchanges: [{ ...regEntry, address: EXCHANGE, validFromBlock: 105 }] });
  assert.equal(finish(createIntelligenceSink({ registry: future })).exchange.reason, 'registry_not_valid_for_entire_range');
  const row = { entity: 'x', asset: usdc.address, emitter: USDC_SYSTEM_EMITTER.toLowerCase(), direction: 'inbound', count: 1, decimals: 6, amountRaw: '1000000' };
  assert.equal(valueExchangeFlow(row,null).usd.status, 'unavailable');
});
await test('already discovered token is not newly discovered again when a new pool observes it later', async () => {
  const { db, store } = fixture();
  for (let index=-1; index<=24; index++) {
    const row=hour(index,{observation:false});
    if (index===-1 || index===24) {
      const blockNumber=row.range.firstBlock+1;
      const b={...block,number:blockNumber,hash:hash(blockNumber),timestamp:row.range.hourStart+10,txHashes:[hash(blockNumber)]};
      const sink=createIntelligenceSink();sink.poolCreated({address:address(700+index),token0:TOKEN,token1:usdc.address,
        createdBlock:blockNumber,createdLogIndex:0,createdTx:hash(blockNumber)},new Map([[blockNumber,b]]));
      row.intelligence=finish(sink,{range:row.range});
    }
    store.commitHour(row);
  }
  for (const item of store.intelligence.pending({now:100,limit:16})) {
    store.intelligence.recordVerification(await verifyTokenCandidate(rpcDouble(),item),{now:100});
  }
  const data=readEcosystem(db,'24h');
  assert.equal(data.coverage.status,'available');assert.equal(data.discoveredTokens.rows.some(row=>row.address===TOKEN),false);
  db.close();
});
await test('new HTTP route uses exact matrix, rejects bodies and returns sanitized errors', () => {
  const handler = createIntelligenceHandler({ readModel: { health() {}, summary() {}, timeseries() {}, pools() {}, activity() {},
    ecosystem(window) { return { schema: ECOSYSTEM_SCHEMA, window: { key: window } }; } } });
  const response = (method, url, headers = {}) => { const out = { writeHead(status) { this.status = status; }, end(text) { this.body = text; } }; handler({ method, url, headers }, out); return out; };
  assert.equal(response('GET', '/v1/intelligence/ecosystem?window=24h').status, 200);
  assert.equal(response('GET', '/v1/intelligence/ecosystem?window=24h&limit=100').status, 400);
  assert.equal(response('POST', '/v1/intelligence/ecosystem?window=24h').status, 405);
  assert.equal(response('GET', '/v1/intelligence/ecosystem?window=24h', { 'content-length': '1' }).status, 400);
});
await test('integration keeps old family versions; no separate DEX fetch or raw archive', () => {
  const source = readFileSync(new URL('../server/compact/intelligence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /eth_getLogs|eth_getBlockByNumber|CREATE TABLE|DATABASE_URL/);
  const hour = readFileSync(new URL('../server/compact/hour.js', import.meta.url), 'utf8');
  assert.match(hour, /onVerifiedDex: intelligence.dex/);
  assert.equal(INTELLIGENCE_VERSION, 'arc-compact-ecosystem-v1');
});
await test('verified discoveries are not crowded out by a later unresolved candidate queue', async () => {
  const { db, store } = fixture(); store.commitHour(hour());
  const [candidate] = store.intelligence.pending({ now: 100, limit: 16 });
  store.intelligence.recordVerification(await verifyTokenCandidate(rpcDouble(), candidate), { now: 100 });
  const source = db.prepare('SELECT * FROM compact_token_discoveries LIMIT 1').get();
  const fields = Object.keys(source);
  const insert = db.prepare(`INSERT INTO compact_token_discoveries (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
  for (let i = 0; i < 60; i++) {
    const row = { ...source, candidate_key: `queued-${i}`, address: address(1000 + i), status: 'unverified', reason: 'provider_rate_limited',
      result_json: null, block_number: source.block_number + i + 1 };
    insert.run(...fields.map((field) => row[field]));
  }
  const data = readEcosystem(db, '30d');
  assert.equal(data.discoveredTokens.rows.some((row) => row.address === TOKEN), true);
  assert.equal(data.launches.rows.some((row) => row.address === TOKEN), true);
  assert.equal(data.contractCandidates.rows.length, 50);
  assert.equal(data.coverage.candidateVerificationComplete, false);
  db.close();
});
await test('combined bounded lists retain proven launches and explicit verified discovery subsets', () => {
  const rows = () => Array.from({ length: 50 }, (_, i) => ({ address: address(i), proof: 'x'.repeat(3500) }));
  const out = { contractCandidates: { rows: rows(), truncated: false }, discoveredTokens: { rows: rows(), truncated: false },
    launches: { rows: rows(), truncated: false } };
  const bounded = boundEcosystemResponse(out);
  assert.ok(bounded); assert.equal(bounded.launches.rows.length, 50);
  assert.ok(bounded.discoveredTokens.rows.length > 0);
  assert.equal(bounded.discoveredTokens.truncated, true);
  assert.equal(bounded.discoveredTokens.reason, 'bounded_response_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 240 * 1024);
});
console.log(`VERIFIER PASS arc-intelligence-ecosystem ${passed} tests (no network, real SQLite)`);
