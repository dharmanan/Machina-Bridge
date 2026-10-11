import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createNetworkReducer } from '../server/intelligence-pipeline/network-reducer.js';
import { createNetworkHourStore, verifyNetworkSeal } from '../server/intelligence-pipeline/network-hour-store.js';
import { protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { createPipelineApiPublication } from '../server/intelligence-pipeline/api-publication.js';
import { sha256Of } from '../server/compact/projections.js';
import { COMPACT_DEFINITION_VERSION as version } from '../server/compact/sources.js';

const root = mkdtempSync(join(tmpdir(), 'arc-api-publication-test-'));
const p = openPipeline({ path: join(root, 'lab.sqlite'), create: true, verifySeal: verifyNetworkSeal });
const publication = createPipelineApiPublication(p), ns = createNetworkHourStore(p);
const A = '0x' + '2'.repeat(40), B = '0x' + '3'.repeat(40), H = n => '0x' + hash(String(n)), R = 'a'.repeat(64);
let checks = 0;
const test = (name, f) => { f(); checks++; console.log('PASS ' + name); };
function prepare(n) {
  const hour = n * 3600, first = n + 1;
  const source = { id: 'network', definition: 'arc-canonical-reduction-v2', chainId: 5042, originalDefinition: version };
  const networkUnit = p.defineUnit({ source, first, last: first, hourStart: hour, anchorHash: H(first), registryDigest: R });
  const reducer = createNetworkReducer({ first, last: first, before: { number: first - 1, hash: H(first - 1), timestamp: hour },
    hourStart: hour, hourEnd: hour + 3600, source, anchorHash: H(first) });
  reducer.addVerifiedSpine({ number: first, hash: H(first), parentHash: H(first - 1), timestamp: hour + 1,
    gasUsed: 100n, txHashes: [H(n + 10000)], txFrom: [A], txTo: [B] });
  p.accept(p.claim({ unitId: networkUnit }), reducer.finish());
  const network = { status: 'available', blockCount: 1, transactionCount: 1, uniqueSenders: 1, uniqueRecipients: 1,
    uniqueActiveAddresses: 2, gasUsedRaw: '100', averageTransactionsPerBlock: 1, transactionsPerSecond: 1 / 3600, internal: { deploymentAttempts: 0 } };
  const range = { kind: 'hour', hourStart: hour, hourEnd: hour + 3600, startUtc: new Date(hour * 1000).toISOString(), endUtc: new Date((hour + 3600) * 1000).toISOString(),
    firstBlock: first, lastBlock: first, parentHash: H(first - 1), firstHash: H(first), lastHash: H(first), firstTimestamp: hour + 1, lastTimestamp: hour + 1 };
  ns.publish(networkUnit, { hour_start: hour, first_block: first, last_block: first, parent_hash: range.parentHash, first_hash: H(first), last_hash: H(first),
    definition_version: version, network_json: JSON.stringify(network), network_sha256: sha256Of({ definitionVersion: version, range, network }) });
  ns.compact(networkUnit);
  const ps = protocolSource('gateway'), metrics = { depositCount: 1, depositAmountRaw: '1000001', uniqueDepositors: 1,
    outboundBurnCount: 0, outboundBurnAmountRaw: '0', outboundBurnFeeRaw: '0',
    outboundByDestinationDomain: { '2': { transferCount: 0, amountRaw: '0' }, '19': { transferCount: 0, amountRaw: '0' } }, inboundMintCount: 0,
    inboundMintAmountRaw: '0', inboundBySourceDomain: {}, uniqueInboundRecipients: 0, withdrawalInitiatedCount: 0, withdrawalCompletedCount: 0, withdrawalAmountRaw: '0' };
  const gateway = p.defineUnit({ source: ps, first, last: first, hourStart: hour, anchorHash: H(first), registryDigest: R });
  p.accept(p.claim({ unitId: gateway }), { format: 'arc-reduced-source-v1', first, last: first, sourceKey: hash(ps), anchorHash: H(first),
    inputSha256: hash([n, 'gateway']), status: 'verified', reason: null, counts: {}, rows: [{ kind: 'verified_protocol_range', family: 'gateway',
      definitionVersion: ps.originalVersion, metrics, membership: { uniqueDepositors: Buffer.from(A.slice(2), 'hex').toString('base64'), uniqueInboundRecipients: '' },
      historicalStateBlock: first, viewProofs: [] }] });
  return { network: { pipeline: p, unitId: networkUnit }, protocols: { gateway: { pipeline: p, unitId: gateway } } };
}

const first = prepare(0);
test('publication rollback retains accepted evidence and no canonical/API/checkpoint rows', () => {
  assert.throws(() => publication.publish({ ...first, beforeCommit: () => { throw Error('crash'); } }), /crash/);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM compact_hours').get().n, 0);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM compact_checkpoint').get().n, 0);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_api_publications').get().n, 0);
  assert.equal(p.coverage(first.network.unitId).status, 'complete');
});
test('crash after commit preserves publication; replay is identical with zero RPC', () => {
  assert.throws(() => publication.publish({ ...first, afterCommit: () => { throw Error('restart'); } }), /restart/);
  assert.equal(publication.publish(first).outcome, 'unchanged'); assert.equal(publication.audit(0).ok, true);
});
test('cross-hour input is rejected before changing accepted API facts', () => {
  const next = prepare(1);
  assert.throws(() => publication.publish({ ...first, protocols: next.protocols }), /api_source_canonical_conflict/);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM compact_hours').get().n, 1);
  publication.publish(next);
});
test('missing derived family is detected and rebuilt exactly from retained evidence', () => {
  const before = p.db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=0 AND family=\'gateway\'').get();
  p.db.prepare("DELETE FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").run();
  assert.equal(publication.audit(0).ok, false);
  assert.equal(publication.publish(first).outcome, 'upgraded');
  assert.deepEqual(p.db.prepare("SELECT * FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").get(), before);
  assert.equal(publication.audit(0).ok, true);
});
test('publication manifest is immutable and unknown families cannot enter API availability', () => {
  assert.throws(() => p.db.prepare('UPDATE arc_pipeline_api_publications SET manifest_json=\'{}\'').run(), /immutable/);
  assert.throws(() => publication.publish({ ...first, protocols: { invented: first.protocols.gateway } }), /api_family_adapter_missing/);
});
// Sparse fixtures exercise contracts, never stand in for real 720-hour mainnet acceptance.
for (let n = 2; n < 720; n++) publication.publish(prepare(n));
const model = publication.readModel({ now: () => 720 * 3600000 });
for (const [window, hours] of [['24h', 24], ['7d', 168], ['30d', 720]]) test('existing API ' + window + ' sums, USD and exact daily distinct; missing DEX not fabricated', () => {
  const s = model.summary(window), t = model.timeseries(window);
  assert.equal(s.network.transactions, hours);
  assert.equal(s.crossChain.gateway.metrics.depositAmountRaw, String(BigInt(hours) * 1000001n));
  assert.equal(s.protocolUsd.gateway.actions.depositUsdMicros.usdMicros, String(BigInt(hours) * 1000001n));
  assert(t.buckets.every(b => b.network.uniqueActiveAddresses === 2));
  assert.equal(s.dex.usdVolume.totalUsdMicros, null);
  assert.equal(model.pools('v3', window).status, 'unavailable');
  assert.equal(model.ecosystem(window).discoveredTokens.rows.length, 0);
});
model.close();
test('only reconstructible API copies expire; permanent seals and verified daily distinct remain', () => {
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM compact_hour_addresses').get().n, 48);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM compact_daily_address_stage').get().n, 0);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_api_days').get().n, 30);
  assert.equal(p.getSeal(first.network.unitId).summary.network.uniqueActiveAddresses, 2);
  assert.equal(publication.audit(0).ok, true);
});
test('daily count corruption is refused after its verified staging cache expires', () => {
  const model = publication.readModel();
  p.db.prepare('UPDATE compact_daily_active_addresses SET active_addresses=999 WHERE day_start=0').run();
  assert.throws(() => model.timeseries('30d'), /read_failed/);
  const repaired = publication.reconcileDays();
  assert.equal(repaired.results[0].status,'repaired'); assert.equal(repaired.results[0].rpcRequests,0);
  assert.equal(model.timeseries('30d').buckets[0].network.uniqueActiveAddresses, 2); model.close();
});
test('concurrent commit cannot replace the verified response snapshot with corrupt values', () => {
  let mutate = true;
  const record = p.db.prepare("SELECT * FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").get();
  const model = publication.readModel({ onSnapshotStarted() {
    if (mutate) { mutate = false; p.db.prepare("UPDATE compact_family_hours SET metrics_json='{}' WHERE hour_start=0 AND family='gateway'").run(); }
  } });
  assert.equal(model.summary('30d').crossChain.gateway.metrics.depositCount, 720);
  assert.throws(() => model.summary('30d'), /read_failed/);
  p.db.prepare("UPDATE compact_family_hours SET metrics_json=? WHERE hour_start=0 AND family='gateway'").run(record.metrics_json); model.close();
});
test('bounded reconciliation automatically restores corrupt committed cache values from exact accepted inputs', () => {
  const checkpoint = { ...p.db.prepare('SELECT * FROM compact_checkpoint').get() };
  const family = p.db.prepare("SELECT * FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").get();
  p.db.prepare("UPDATE compact_family_hours SET metrics_json='{}',metrics_sha256=? WHERE hour_start=0 AND family='gateway'").run(hash('{}'));
  const restored = publication.reconcile(hour => { assert.equal(hour, 0); return first; }, { maxHours: 1 });
  assert.equal(restored.results[0].status, 'repaired'); assert.equal(restored.scannedHours, 1);
  assert.deepEqual(p.db.prepare("SELECT * FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").get(), family);
  assert.deepEqual({ ...p.db.prepare('SELECT * FROM compact_checkpoint').get() }, checkpoint);
  assert.equal(p.db.prepare("SELECT COUNT(*) n FROM arc_pipeline_api_cache_repairs WHERE dataset<>'daily_active_addresses'").get().n, 1);
  assert.equal(publication.reconcile(() => { throw Error('must not load verified work'); }, { maxHours: 1 }).results[0].status, 'verified');
  assert.throws(() => publication.reconcile(() => first, { maxHours: 5 }), /api_reconcile_budget_invalid/);
});
test('daily missing copy repairs after rollback and restart without repeat downloads or checkpoint mutation', () => {
  const checkpoint = { ...p.db.prepare('SELECT * FROM compact_checkpoint').get() };
  p.db.prepare('DELETE FROM compact_daily_active_addresses WHERE day_start=0').run();
  assert.equal(publication.reconcileDays(undefined,{beforeCommit(){throw Error('lab_crash');}}).results[0].status,'blocked');
  assert.equal(p.db.prepare('SELECT * FROM compact_daily_active_addresses WHERE day_start=0').get(),undefined);
  assert.equal(publication.reconcileDays().results[0].status,'repaired');
  assert.equal(publication.reconcileDays(()=>{throw Error('repeat_source_read');}).results[0].status,'verified');
  assert.deepEqual({ ...p.db.prepare('SELECT * FROM compact_checkpoint').get() },checkpoint);
});
test('daily source absence fails closed and preserves damaged-copy evidence', () => {
  p.db.prepare('UPDATE compact_daily_active_addresses SET active_addresses=99 WHERE day_start=0').run();
  assert.equal(publication.reconcileDays(()=>({pipeline:p,unitId:'f'.repeat(64)})).results[0].status,'blocked');
  assert.equal(p.db.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start=0').get().active_addresses,99);
  assert.equal(publication.reconcileDays().results[0].status,'repaired');
  assert.throws(()=>publication.reconcileDays(undefined,{maxDays:2}),/api_daily_reconcile_budget_invalid/);
});
test('read-only evidence accepts temporary distinct queries and refuses every durable transaction', () => {
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const q = openPipeline({ path: p.path, readOnly: true, verifySeal: verifyNetworkSeal });
  assert.equal(q.getSeal(first.network.unitId).summary.network.transactionCount, 1);
  assert.throws(() => q.transaction(() => {}), /pipeline_read_only/);
  assert.throws(() => q.db.prepare('DELETE FROM arc_pipeline_units').run(), /readonly|read-only/i);
  q.db.exec('CREATE TEMP TABLE scratch(n INTEGER); INSERT INTO scratch VALUES(1); DROP TABLE scratch'); q.close();
});
test('API refuses corrupted values or membership instead of showing numeric data', () => {
  const model = publication.readModel();
  const family = p.db.prepare("SELECT * FROM compact_family_hours WHERE hour_start=0 AND family='gateway'").get();
  p.db.prepare("UPDATE compact_family_hours SET metrics_json='{}' WHERE hour_start=0 AND family='gateway'").run();
  assert.throws(() => model.summary('30d'), /read_failed/);
  p.db.prepare("UPDATE compact_family_hours SET metrics_json=? WHERE hour_start=0 AND family='gateway'").run(family.metrics_json);
  assert.equal(model.summary('30d').network.transactions, 720);
  const member = p.db.prepare('SELECT * FROM compact_hour_addresses WHERE hour_start=719*3600 LIMIT 1').get();
  p.db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start=? AND address=?').run(member.hour_start, member.address);
  assert.throws(() => model.summary('24h'), /read_failed/);
  p.db.prepare('INSERT INTO compact_hour_addresses VALUES(?,?)').run(member.hour_start, member.address);
  assert.equal(model.summary('24h').network.transactions, 24); model.close();
});
console.log(JSON.stringify({ checks, heapBudget: assertHeapBudget(), node: process.version, rpcRequests: 0,
  scope: 'synthetic API publication regressions, not real 720-hour acceptance', lab: root }));
p.close();
