import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createProtocolProcessor, createPinnedViewCache, deriveProtocolMetrics, protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { GATEWAY_EVENTS, CIRCLE_ARC } from '../server/compact/protocols/circle.js';
import { AAVE_V4_EVENTS, AAVE_V4_ARC } from '../server/compact/protocols/aave.js';
import { MORPHO_BLUE_EVENTS, MORPHO_ARC } from '../server/compact/protocols/morpho.js';

const H = '0x' + '1'.repeat(64), A = '0x' + '2'.repeat(40), B = '0x' + '3'.repeat(40);
const word = n => BigInt(n).toString(16).padStart(64, '0'), topic = a => '0x' + a.slice(2).padStart(64, '0');
const window = n => new Map([[n, { hash: H, timestamp: n, txHashes: [H], txFrom: [A] }]]);
const raw = (n, emitter, topics, data) => ({ address: emitter, blockNumber: '0x' + n.toString(16),
  blockHash: H, transactionHash: H, transactionIndex: '0x0', logIndex: '0x0', topics, data: '0x' + data, removed: false });
let checks = 0;
const test = async (name, f) => { await f(); checks++; console.log('PASS ' + name); };
const lab = () => openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-protocol-test-')), 'lab.sqlite'), create: true });
function provider(logs = []) {
  let calls = 0;
  return { get calls() { return calls; }, canContinue: () => true,
    async request(method, params) {
      calls++;
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getLogs') return logs.filter(l => Number(l.blockNumber) >= Number(params[0].fromBlock) && Number(l.blockNumber) <= Number(params[0].toBlock));
      if (method === 'eth_call') return '0x' + [CIRCLE_ARC.usdc, AAVE_V4_ARC.coreHub, 0, 6, 0, 0, 0].map(x => typeof x === 'string' ? x.slice(2).padStart(64, '0') : word(x)).join('');
      throw Error('unexpected method');
    } };
}
function spec(name) { return { source: protocolSource(name), first: 10, last: 11, hourStart: 0, anchorHash: H, registryDigest: 'a'.repeat(64) }; }
await test('entire V8 heap remains below 64 MiB', () => assert(assertHeapBudget().configuredLimitBytes <= 64 * 1024 * 1024));
await test('Gateway strict USDC amounts and hour-wide distinct depositor membership', async () => {
  const p = lab(), x = spec('gateway'), u = p.defineUnit(x, { chunkBlocks: 1 }), rpc = provider([10, 11].map(n => raw(n,
    CIRCLE_ARC.gatewayWallet, [GATEWAY_EVENTS.deposited.topic, topic(CIRCLE_ARC.usdc), topic(A), topic(B)], word(1234567))));
  const processor = createProtocolProcessor(p, { family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
  for (let j; j = p.claim({ unitId: u });) p.accept(j, (await processor.processJob(j, rpc)).summary);
  const metrics = deriveProtocolMetrics(p, u, 'gateway');
  assert.equal(metrics.depositAmountRaw, '2469134'); assert.equal(metrics.depositCount, 2); assert.equal(metrics.uniqueDepositors, 1);
  assert.equal(rpc.calls, 6); // Four pinned code checks are cached across the two ranges.
  assert.doesNotMatch(JSON.stringify([...p.summaries(u)]), /"topics"|"data"|"transactions"/);
  const path = p.path; p.close(); const q = openPipeline({ path });
  assert.equal(q.claim({ unitId: u }), null); assert.deepEqual(deriveProtocolMetrics(q, u, 'gateway'), metrics); q.close();
});
await test('Aave and Morpho same-named Supply events retain their distinct ABIs', async () => {
  const p = lab(), u = p.defineUnit(spec('aaveV4'));
  const rpc = provider([raw(10, AAVE_V4_ARC.mainSpoke, [AAVE_V4_EVENTS.supply.topic, '0x' + word(0), topic(A), topic(B)], word(5) + word(1000000))]);
  const processor = createProtocolProcessor(p, { family: 'aaveV4', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
  const j = p.claim({ unitId: u }); p.accept(j, (await processor.processJob(j, rpc)).summary);
  const m = deriveProtocolMetrics(p, u, 'aaveV4'); assert.equal(m.supplyCount, 1); assert.equal(m.uniqueUsers, 1);
  assert.equal(m.reserves[AAVE_V4_ARC.mainSpoke + ':0'].suppliedRaw, '1000000');
  assert.notEqual(AAVE_V4_EVENTS.supply.topic, MORPHO_BLUE_EVENTS.supply.topic); assert(MORPHO_ARC.blue); p.close();
});
await test('unexpected Gateway token cannot become accepted evidence', async () => {
  const p = lab(), u = p.defineUnit(spec('gateway')), processor = createProtocolProcessor(p, {
    family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
  const j = p.claim({ unitId: u }); await assert.rejects(processor.processJob(j, provider([raw(10,
    CIRCLE_ARC.gatewayWallet, [GATEWAY_EVENTS.deposited.topic, topic(B), topic(A), topic(B)], word(1))])), e => e.code === 'gateway_unexpected_token');
  assert.equal(p.coverage(u).status, 'partial'); assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_results').get().n, 0); p.close();
});
await test('canonical hash mismatch and malformed official event fail closed', async () => {
  for (const changed of [{ blockHash: '0x' + '9'.repeat(64) }, { data: '0x00' }, { transactionIndex: '0x1' }]) {
    const p = lab(), u = p.defineUnit(spec('gateway')), processor = createProtocolProcessor(p, {
      family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
    const l = raw(10, CIRCLE_ARC.gatewayWallet, [GATEWAY_EVENTS.deposited.topic, topic(CIRCLE_ARC.usdc), topic(A), topic(B)], word(1));
    await assert.rejects(processor.processJob(p.claim({ unitId: u }), provider([{ ...l, ...changed }])));
    assert.equal(p.coverage(u).status, 'partial'); p.close();
  }
});
await test('deleted/corrupt pinned value repairs only to its independently accepted checksum', async () => {
  const p = lab(), resolve = createPinnedViewCache(p), rpc = provider();
  assert.equal(await resolve(rpc, 'eth_getCode', [A, '0xa'], H), '0x6000');
  p.db.exec('UPDATE arc_pipeline_pinned_views SET response_json=NULL');
  assert.equal(await resolve(rpc, 'eth_getCode', [A, '0xa'], H), '0x6000'); assert.equal(rpc.calls, 2);
  p.db.exec('UPDATE arc_pipeline_pinned_views SET response_json=NULL');
  await assert.rejects(resolve({ canContinue: () => true, request: async () => '0x6001' }, 'eth_getCode', [A, '0xa'], H), e => e.code === 'pinned_view_conflict');
  assert.throws(() => p.db.exec("UPDATE arc_pipeline_pinned_views SET response_sha='changed'")); p.close();
});
await test('early yield makes no RPC and preserves already committed pinned evidence', async () => {
  const p = lab(), resolve = createPinnedViewCache(p), rpc = provider();
  await resolve(rpc, 'eth_getCode', [A, '0xa'], H); let requests = 0;
  await assert.rejects(resolve({ canContinue: () => false, request: async () => { requests++; } }, 'eth_getCode', [B, '0xa'], H), e => e.code === 'bounded_run_yield');
  assert.equal(requests, 0); assert.equal(await resolve(rpc, 'eth_getCode', [A, '0xa'], H), '0x6000'); assert.equal(rpc.calls, 1); p.close();
});
await test('code absent at a historical boundary does not invent a validity start', async () => {
  const p = lab(), u = p.defineUnit(spec('gateway')), processor = createProtocolProcessor(p, {
    family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 }); let requests = 0;
  await assert.rejects(processor.processJob(p.claim({ unitId: u }), { canContinue: () => true,
    request: async () => { requests++; return '0x'; } }), e => e.code === 'protocol_validity_requires_deployment_evidence');
  assert.equal(requests, 1); assert.equal(p.coverage(u).status, 'partial'); p.close();
});
await test('malformed accepted counts and amounts cannot produce numeric window metrics', async () => {
  for (const [field, value] of [['depositCount', -1], ['depositCount', 1.5], ['depositCount', '1'],
    ['depositAmountRaw', '-1'], ['depositAmountRaw', '01'], ['depositAmountRaw', null]]) {
    const p = lab(), u = p.defineUnit(spec('gateway')), processor = createProtocolProcessor(p, {
      family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
    const j = p.claim({ unitId: u }), { summary } = await processor.processJob(j, provider());
    summary.rows[0].metrics[field] = value; p.accept(j, summary);
    await assert.rejects(async () => deriveProtocolMetrics(p, u, 'gateway'), e => e.code === 'protocol_metrics_invalid'); p.close();
  }
});
await test('omitted membership proof fails instead of inventing a distinct address count', async () => {
  const p = lab(), u = p.defineUnit(spec('gateway')), processor = createProtocolProcessor(p, {
    family: 'gateway', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
  const j = p.claim({ unitId: u }), { summary } = await processor.processJob(j, provider());
  delete summary.rows[0].membership.uniqueDepositors; p.accept(j, summary);
  assert.throws(() => deriveProtocolMetrics(p, u, 'gateway'), e => e.code === 'protocol_membership_mismatch'); p.close();
});
await test('budget and transport diagnostics survive protocol readViews wrappers with no extra RPC', async () => {
  for (const code of ['recovery_response_budget_exhausted', 'transport', 'body_read', 'timeout']) {
    const p = lab(), u = p.defineUnit(spec('aaveV4')), base = provider([raw(10, AAVE_V4_ARC.mainSpoke,
      [AAVE_V4_EVENTS.supply.topic, '0x' + word(0), topic(A), topic(B)], word(5) + word(1000000))]);
    let failed = false, laterCalls = 0;
    const rpc = { canContinue: () => true, async request(method, params) {
      if (failed) laterCalls++;
      if (method === 'eth_call') { failed = true; throw Object.assign(Error(code), { code }); }
      return base.request(method, params);
    } };
    const processor = createProtocolProcessor(p, { family: 'aaveV4', loadVerifiedWindow: window, hourFirstBlock: 10, hourLastBlock: 11 });
    await assert.rejects(processor.processJob(p.claim({ unitId: u }), rpc), e => e.code === code);
    assert.equal(laterCalls, 0); assert.equal(p.coverage(u).status, 'partial'); p.close();
  }
});
console.log(JSON.stringify({ checks, node: process.version, scope: 'synthetic protocol safety tests', productionAccess: false }));
