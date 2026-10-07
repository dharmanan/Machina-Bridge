// P8 only. Codespace Node24, offline doubles + disposable in-memory SQLite. Never open production or scan history.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbiItem, toEventSelector } from 'viem';
import { readView as originalReadView } from '../api/_lib/arc-intelligence/circle-common.js';
import { P1A_LAUNCHPAD_CANDIDATES } from '../api/_lib/arc-intelligence/p1a-registry.js';
import { ARGUS_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/argus.js';
import { TOLLY_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/tolly.js';
import { OPENLAUNCH_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/openlaunch.js';
import { ARCHEMIST_V2_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/archemist-v2.js';
import { INTELLIGENCE_REGISTRY, intelligenceRegistry, extensionStreams, registryDigest } from '../server/compact/intelligence-registry.js';
import { COMPACT_LAUNCH_SOURCES, verifyCompactLaunchSource } from '../server/compact/launch-sources.js';
import { createIntelligenceSink, classifyLaunch, verifyTokenCandidate, DISCOVERY_READS_PER_RUN } from '../server/compact/intelligence.js';
import { readEcosystem, discoveryWorkDue } from '../server/compact/intelligence-store.js';
import { createCompactStore } from '../server/compact/store.js';
import { selectorOf } from '../server/compact/abi.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { processBlockRange } from '../server/compact/hour.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { headerOf } from '../server/compact/spine.js';

globalThis.fetch = async () => { throw new Error('network_forbidden'); };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const TOKEN = address(800), CREATOR = address(801), CALLER = address(802);
const FIRST = 23000000, LAST = FIRST + 49, TIME = Date.parse('2026-10-07T09:00:00Z') / 1000;
const range = { kind: 'hour', hourStart: TIME, hourEnd: TIME + 3600, firstBlock: FIRST, lastBlock: LAST,
  parentHash: hash(FIRST - 1), firstHash: hash(FIRST), lastHash: hash(LAST) };
const block = { number: FIRST + 1, hash: hash(FIRST + 1), timestamp: TIME + 10,
  txHashes: [hash(FIRST + 1)], txFrom: [CALLER], txTo: [address(900)] };
const window = new Map([[block.number, block]]);
const families = { usdc: { status: 'available' }, assets: { status: 'available' },
  uniswapV3: { status: 'available' }, uniswapV4: { status: 'available' } };
const projections = { uniswap_v3_pools: { status: 'available' }, uniswap_v4_pools: { status: 'available' } };
const finish = (sink, changes = {}) => sink.finish({ range, families, projections, codePresent: () => true, ...changes });
const adapters = [ARGUS_ADAPTER, TOLLY_ADAPTER, OPENLAUNCH_ADAPTER, ARCHEMIST_V2_ADAPTER];
const streamOf = protocol => extensionStreams(INTELLIGENCE_REGISTRY).find(stream => stream.entry.protocol === protocol);
function logOf(protocol, changes = {}) {
  const adapter = adapters.find(adapter => adapter.protocol === protocol);
  const args = Object.fromEntries(adapter.abi.inputs.map(input => [input.name,
    input.name === 'token' ? TOKEN : ['creator', 'launcher'].includes(input.name) ? CREATOR
      : input.type === 'address' ? address(803) : input.type === 'bytes32' ? hash(804)
        : input.type === 'string' ? 'ABI fixture only' : input.type.startsWith('int') ? -1n : 1n]));
  const unindexed = adapter.abi.inputs.filter(input => !input.indexed);
  return { address: streamOf(protocol).entry.address, blockNumber: block.number, transactionIndex: 0,
    transactionHash: block.txHashes[0], logIndex: 7,
    topics: encodeEventTopics({ abi: [adapter.abi], eventName: adapter.abi.name, args }).map(topic => topic.toLowerCase()),
    data: encodeAbiParameters(unindexed, unindexed.map(input => args[input.name])).toLowerCase(), ...changes };
}
function rpc({ code = null, view = null, optionalMissing = false, db = null } = {}) {
  const calls = [];
  const factory = (to) => INTELLIGENCE_REGISTRY.launches.find(entry => entry.address === to);
  const tokenViews = { 'totalSupply()': `0x${word(10n ** 50n)}`, 'balanceOf(address)': `0x${word(0n)}`,
    'symbol()': optionalMissing ? '0x' : `0x${Buffer.from('REAL').toString('hex').padEnd(64, '0')}`,
    'name()': optionalMissing ? '0x' : `0x${Buffer.from('Verified fixture').toString('hex').padEnd(64, '0')}`,
    'decimals()': optionalMissing ? '0x' : `0x${word(18n)}` };
  return { calls, async request(method, params) {
    assert.notEqual(db?.isTransaction, true, 'RPC must stay outside the SQLite transaction'); calls.push([method, params]);
    const entry = factory(method === 'eth_getCode' ? params[0] : params[0].to);
    assert.ok(entry, 'only the existing source verifier calls request');
    if (method === 'eth_getCode') return code ? code(entry, params.at(-1)) : `0x60${entry.events[0].event.topic.slice(2)}`;
    assert.equal(method, 'eth_call');
    const adapter = adapters.find(adapter => adapter.protocol === entry.protocol);
    assert.equal(params[0].data, encodeFunctionData({ abi: [parseAbiItem(adapter.view.signature)],
      functionName: adapter.view.functionName, args: [] }), 'shared view calldata equals the original independent ABI encoder');
    if (view) return view(entry, params.at(-1));
    if (entry.protocol === 'Argus') return `0x${word(11n)}`;
    if (entry.protocol === 'Tolly') return `0x${word('0x3600000000000000000000000000000000000000')}`;
    return `0x${word(0n)}`;
  }, async batch(requests) {
    assert.notEqual(db?.isTransaction, true); calls.push(...requests);
    return requests.map(([method, params]) => {
      if (method === 'eth_getCode') return { result: '0x6000' };
      const signature = Object.keys(tokenViews).find(signature => selectorOf(signature) === params[0].data.slice(0, 10));
      return signature ? { result: tokenViews[signature] } : { error: { code: 3, message: 'execution reverted' } };
    });
  } };
}
async function observed(protocol, provider = rpc()) {
  const sink = createIntelligenceSink(); sink.extension(streamOf(protocol), [logOf(protocol)], window);
  await sink.verifyLaunchSources(provider, range);
  const output = finish(sink);
  return { sink, output, candidate: output.discovery.candidates[0] };
}
function hour(payload) {
  return { definitionVersion: COMPACT_DEFINITION_VERSION, sourceVersions: {}, chainId: 5042, range,
    network: { status: 'available', blockCount: 50, transactionCount: 1, uniqueActiveAddresses: 0 }, activeAddresses: [],
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name,
      { status: 'unavailable', reason: 'fixture', ...Object.fromEntries(fields.map(field => [field, null])) }])),
    complete: false, registry: { uniswapV3: null }, intelligence: payload };
}

await test('exactly four existing official candidates activate; other candidate listings/exchanges/protocols do not', () => {
  assert.equal(COMPACT_LAUNCH_SOURCES.length, 4);
  assert.deepEqual(COMPACT_LAUNCH_SOURCES.map(entry => entry.protocol).sort(), ['Archemist V2', 'Argus', 'Openlaunch', 'Tolly']);
  assert.equal(INTELLIGENCE_REGISTRY.exchanges.length, 0); assert.equal(INTELLIGENCE_REGISTRY.protocols.length, 0);
  for (const entry of INTELLIGENCE_REGISTRY.launches) {
    const candidate = P1A_LAUNCHPAD_CANDIDATES.find(candidate => candidate.protocol === entry.protocol);
    for (const field of ['version', 'address', 'source', 'sourceKey', 'verificationStatus']) assert.equal(entry[field], candidate[field]);
    assert.equal(entry.validFromBlock, candidate.effectiveFromBlock);
    assert.equal(entry.sourceDefinitionVersion, 'arc-intelligence-launchpads-v1');
  }
});
await test('unknown deployment boundaries remain null; only the established Openlaunch boundary is numeric', () => {
  for (const entry of INTELLIGENCE_REGISTRY.launches) {
    assert.equal(entry.validFromBlock, entry.protocol === 'Openlaunch' ? 21165817 : null);
    assert.equal(entry.validityBasis, entry.validFromBlock === null ? 'deployment_boundary_not_established' : 'existing_P1A_deployment_boundary');
  }
});
await test('duplicate factory/id definitions fail closed case insensitively', () => {
  const entry = COMPACT_LAUNCH_SOURCES[0];
  assert.throws(() => intelligenceRegistry({ launches: [entry, entry] }), /duplicate/);
  assert.throws(() => intelligenceRegistry({ launches: [entry, { ...entry, id: 'duplicate', address: entry.address.toUpperCase().replace('0X', '0x') }] }), /registry/);
});
await test('unverified listing and altered official address/ABI/version/provenance/mapping cannot opt into the policy', () => {
  const entry = COMPACT_LAUNCH_SOURCES[0];
  for (const changes of [{ verificationStatus: 'unverified' }, { address: address(999) }, { version: 'guessed' },
    { source: 'ecosystem_listing' }, { sourceKey: 'guessed' }, { validFromBlock: 0 },
    { events: [{ ...entry.events[0], tokenField: 'creator' }] },
    { events: [{ ...entry.events[0], creatorField: 'missing' }] },
    { events: [{ ...entry.events[0], declaration: 'event Created(address indexed token)' }] }]) {
    assert.throws(() => intelligenceRegistry({ launches: [{ ...entry, ...changes }] }), /registry|definition/);
  }
});
for (const adapter of adapters) {
  await test(`${adapter.protocol}: canonical topic/ABI and deterministic token/creator mapping`, async () => {
    const stream = streamOf(adapter.protocol); assert.equal(stream.entry.events[0].event.topic, toEventSelector(adapter.abi).toLowerCase());
    assert.deepEqual(adapter.abi, parseAbiItem(stream.entry.events[0].declaration), 'shared ABI shape equals the original independent parser');
    const { candidate, output } = await observed(adapter.protocol);
    assert.equal(candidate.address, TOKEN); assert.equal(candidate.caller, CALLER); assert.equal(candidate.deployer, null);
    assert.equal(candidate.launchEvidence.creator, adapter.creatorField ? CREATOR : null);
    assert.equal(candidate.launchEvidence.emitter, stream.entry.address); assert.equal(candidate.launchEvidence.logIndex, 7);
    assert.equal(output.discovery.status, 'available'); assert.equal(output.discovery.allArcTokensComplete, false);
  });
  await test(`${adapter.protocol}: historical factory/topic/view verification and launch provenance`, async () => {
    const { candidate } = await observed(adapter.protocol); const provider = rpc();
    const result = await verifyTokenCandidate(provider, candidate);
    assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.symbol, 'REAL'); assert.equal(result.decimals, 18);
    assert.equal(result.launch.status, 'verified_launchpad'); assert.equal(result.launch.protocol, adapter.protocol);
    assert.equal(result.launch.version, streamOf(adapter.protocol).entry.version);
    assert.equal(result.launch.observedAt, block.timestamp); assert.equal(result.launch.transactionHash, block.txHashes[0]);
    assert.equal(result.launch.blockNumber, block.number); assert.equal(result.launch.logIndex, 7);
    assert.equal(result.launch.creator.status, adapter.creatorField ? 'available' : 'unavailable');
    if (adapter.creatorField) assert.equal(result.launch.creator.address, CREATOR);
    assert.equal(result.directDeploymentVerified, false); assert.equal(result.launch.provenance.evidence.factoryEvidence.status, 'verified');
    for (const [, params] of provider.calls) assert.equal(params.at(-1), `0x${LAST.toString(16)}`);
  });
}
await test('source window verification pins both edges when deployment boundary is unknown, never latest', async () => {
  const provider = rpc(); await observed('Argus', provider);
  for (const entry of INTELLIGENCE_REGISTRY.launches) {
    const tags = provider.calls.filter(([method, params]) => method === 'eth_getCode' && params[0] === entry.address).map(([, params]) => params[1]);
    assert.deepEqual(tags, entry.validFromBlock === null ? [`0x${LAST.toString(16)}`, `0x${FIRST.toString(16)}`] : [`0x${LAST.toString(16)}`]);
  }
});
await test('simple bytecode presence without official topic is insufficient, token remains retryable unknown-source', async () => {
  const { candidate } = await observed('Argus'); const provider = rpc({ code: () => '0x6000' });
  const result = await verifyTokenCandidate(provider, candidate);
  assert.equal(result.status, 'verified_erc20_like'); assert.equal(result.launch.status, 'unknown_source');
  assert.equal(result.launchEvidence.factoryEvidence.reason, 'official_event_topic_not_in_bytecode');
  const sink = createIntelligenceSink(); await sink.verifyLaunchSources(provider, range);
  assert.equal(finish(sink).discovery.status, 'insufficient_coverage');
});
await test('required source view mismatch/transient RPC fails closed without leaking arbitrary errors', async () => {
  for (const provider of [rpc({ view: () => '0x' }), rpc({ code: () => { throw new Error('private_rpc_body'); } })]) {
    const { candidate } = await observed('Tolly'); const result = await verifyTokenCandidate(provider, candidate);
    assert.equal(result.launch.status, 'unknown_source'); assert.doesNotMatch(JSON.stringify(result), /private_rpc_body/);
    const proof = await verifyCompactLaunchSource(provider, streamOf('Tolly').entry, LAST); assert.equal(proof.status, 'unavailable');
  }
  // Preserve single-word view values and failure decisions, including large uints and the old address decoder's casing.
  for (const [protocol, value] of [['Argus', `0x${word(11n)}`], ['Argus', `0x${word(2n ** 255n)}`],
    ['Openlaunch', `0x${word(2n ** 256n - 1n)}`], ['Tolly', `0x${word('0x3600000000000000000000000000000000000000')}`],
    ['Tolly', `0x${'f'.repeat(24)}${'abcdef0123456789'.repeat(2)}abcdef01`], ['Tolly', '0x01']]) {
    const adapter = adapters.find(adapter => adapter.protocol === protocol);
    const entry = streamOf(protocol).entry; const tag = `0x${LAST.toString(16)}`;
    const original = await originalReadView(rpc({ view: () => value }), entry.address, adapter.view.signature,
      adapter.view.functionName, [], tag);
    const proof = await verifyCompactLaunchSource(rpc({ view: () => value }), entry, LAST);
    assert.equal(proof.viewResult, typeof original === 'bigint' ? original.toString(10) : original);
    assert.equal(proof.viewVerified, adapter.view.verify(original));
    assert.equal(proof.status, adapter.view.verify(original) ? 'verified' : 'unavailable');
  }
});
await test('absent start-edge factory and missing runtime proof cannot certify a whole window', async () => {
  const provider = rpc({ code: (entry, tag) => tag === `0x${FIRST.toString(16)}` ? '0x' : `0x60${entry.events[0].event.topic.slice(2)}` });
  const { output } = await observed('Argus', provider); assert.equal(output.discovery.status, 'insufficient_coverage');
  const sink = createIntelligenceSink(); assert.equal(finish(sink).discovery.status, 'insufficient_coverage');
  await sink.verifyLaunchSources(rpc(), range);
  assert.equal(finish(sink, { range: { ...range, lastBlock: LAST + 1 } }).discovery.status, 'insufficient_coverage');
});
await test('known deployment boundary cannot certify earlier/straddling windows', async () => {
  const sink = createIntelligenceSink(); const oldRange = { ...range, firstBlock: 21165816, lastBlock: 21165818 };
  await sink.verifyLaunchSources(rpc(), oldRange);
  const row = finish(sink, { range: oldRange }).launchSources.find(row => row.protocol === 'Openlaunch');
  assert.equal(row.status, 'unavailable'); assert.equal(row.reason, 'registry_not_valid_for_entire_range');
});
await test('wrong emitter, malformed ABI, zero token and unavailable streams never fabricate launch rows', async () => {
  for (const changes of [{ address: address(999) }, { data: '0x01' },
    { topics: [streamOf('Argus').entry.events[0].event.topic, hash(0), hash(801)] }]) {
    const sink = createIntelligenceSink(); sink.extension(streamOf('Argus'), [logOf('Argus', changes)], window);
    await sink.verifyLaunchSources(rpc(), range); const out = finish(sink);
    assert.deepEqual(out.discovery.candidates, []); assert.equal(out.discovery.status, 'insufficient_coverage');
  }
  const sink = createIntelligenceSink(); sink.failExtension(streamOf('Argus')); await sink.verifyLaunchSources(rpc(), range);
  assert.deepEqual(finish(sink).discovery.candidates, []); assert.equal(finish(sink).discovery.status, 'insufficient_coverage');
});
await test('candidate version/emitter/signature/factory mismatch is unknown, never inferred from pool evidence', async () => {
  const { candidate } = await observed('Argus'); const result = await verifyTokenCandidate(rpc(), candidate);
  for (const changes of [{ version: 'wrong' }, { emitter: address(999) }, { eventSignature: 'wrong' },
    { codeVerified: false }, { factoryEvidence: { status: 'unavailable' } }]) {
    assert.equal(classifyLaunch({ ...result, launchEvidence: { ...result.launchEvidence, ...changes } }).status, 'unknown_source');
  }
  assert.equal(classifyLaunch({ ...candidate, launchEvidence: null, poolEvidence: { protocol: 'uniswap_v3' } }).status, 'unknown_source');
});
await test('optional token labels remain absent; event strings/caller are not invented token metadata or deployment', async () => {
  const { candidate } = await observed('Openlaunch'); const result = await verifyTokenCandidate(rpc({ optionalMissing: true }), candidate);
  assert.equal(result.symbol, null); assert.equal(result.name, null); assert.equal(result.decimals, null);
  assert.equal(result.launch.creator.status, 'unavailable'); assert.equal(result.directDeploymentVerified, false);
});
await test('real SQLite persists source/version/creator/log identity without A2 coupling or schema change', async () => {
  const db = new DatabaseSync(':memory:'); try {
    const store = createCompactStore(db); const { output } = await observed('Argus', rpc({ db }));
    store.commitHour(hour(output)); const checkpoint = store.checkpoint();
    const [item] = store.intelligence.pending({ now: 100, limit: 16 });
    const result = await verifyTokenCandidate(rpc({ db }), item); store.intelligence.recordVerification(result, { now: 100 });
    assert.deepEqual(store.checkpoint(), checkpoint); assert.equal(discoveryWorkDue(db, 10 ** 12), false);
    const read = readEcosystem(db, '24h'); assert.equal(read.launches.rows.length, 1);
    assert.equal(read.launchSources.find(source => source.protocol === 'Argus').events[0].topic, toEventSelector(ARGUS_ADAPTER.abi).toLowerCase());
    const token = read.launches.rows[0]; assert.equal(token.address, TOKEN); assert.equal(token.symbol, 'REAL');
    assert.equal(token.launch.creator.address, CREATOR); assert.equal(token.launch.logIndex, 7);
    assert.equal(token.launch.observedAt, new Date(block.timestamp * 1000).toISOString());
    assert.equal(token.deployment.status, 'unavailable'); assert.equal(token.dex.status, 'unavailable');
    assert.equal(read.coverage.availableHours, 1); assert.equal(read.coverage.status, 'insufficient_coverage');
    assert.equal(db.prepare("SELECT value FROM compact_meta WHERE key='schema_version'").get().value, '2');
  } finally { db.close(); }
});
await test('source factory failure stays in existing cooldown/retry queue; sixteen cap and eight/eight quotas unchanged', async () => {
  assert.equal(DISCOVERY_READS_PER_RUN, 16);
  const db = new DatabaseSync(':memory:'); try {
    const store = createCompactStore(db); const { output } = await observed('Argus'); store.commitHour(hour(output));
    const [item] = store.intelligence.pending({ now: 100, limit: 16 });
    store.intelligence.recordVerification(await verifyTokenCandidate(rpc({ code: () => '0x' }), item), { now: 100 });
    assert.equal(discoveryWorkDue(db, 101), false); assert.equal(discoveryWorkDue(db, 3600100), true);
    assert.deepEqual(store.intelligence.pending({ now: 3600100, limit: 16 }).map(item => item.key), [item.key]);
    assert.throws(() => store.intelligence.pending({ now: 100, limit: 17 }), /limit/);
    const source = readFileSync(new URL('../server/compact/intelligence-store.js', import.meta.url), 'utf8');
    assert.match(source, /Math\.ceil\(limit \/ 2\)/); assert.match(source, /limit - retryCount/);
    assert.match(source, /selected\.push\(\.\.\.retries\.slice/);
    // Full deterministic fresh/retry starvation + borrowing cases remain in the existing 60-test ecosystem verifier.
  } finally { db.close(); }
});
await test('old stored aggregates and pre-activation registry digests are not silently promoted', async () => {
  const db = new DatabaseSync(':memory:'); try {
    const store = createCompactStore(db); const old = hour(null); delete old.intelligence; store.commitHour(old);
    const read = readEcosystem(db, '24h'); assert.equal(read.coverage.availableHours, 0); assert.deepEqual(read.launches.rows, []);
    assert.notEqual(registryDigest(intelligenceRegistry({ launches: [] })), registryDigest());
  } finally { db.close(); }
});
await test('normal range processor actually requests registered streams and runs bounded source checks outside DB', async () => {
  const chain = createSyntheticChain({ originNumber: FIRST, poolCreatedAt: FIRST, protocols: false });
  const provider = createProvider({ fetchImpl: chain.fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
  const original = provider.request.bind(provider); const proofProvider = rpc();
  const withSources = { ...provider, request: async (method, params, options) =>
    ['eth_getCode', 'eth_call'].includes(method) && INTELLIGENCE_REGISTRY.launches.some(entry => entry.address === (method === 'eth_getCode' ? params[0] : params[0].to))
      ? proofProvider.request(method, params) : original(method, params, options) };
  const result = await processBlockRange({ provider: withSources, first: FIRST, last: LAST,
    before: headerOf(chain.rawBlock(FIRST - 1), FIRST - 1),
    v3Registry: { through: FIRST - 1, throughHash: chain.blockHash(FIRST - 1), pools: new Set() } });
  assert.equal(result.intelligence.launchSources.length, 4);
  assert.ok(result.intelligence.launchSources.every(row => row.status === 'available' && row.factoryEvidence.status === 'verified'));
  assert.equal(provider.stats.calls.eth_getTransactionReceipt ?? 0, 0);
  assert.ok(proofProvider.calls.length <= 14, 'four existing sources, at most two pinned verification edges');
});

console.log(`VERIFIER PASS compact-launch-registry ${passed} tests (offline, real disposable SQLite)`);
