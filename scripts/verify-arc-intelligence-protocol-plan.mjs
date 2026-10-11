import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline, hash } from '../server/intelligence-pipeline/storage.js';
import { protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { refineProtocolPlan } from '../server/intelligence-pipeline/protocol-plan.js';
const p = openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-protocol-plan-')), 'lab.sqlite'), create: true });
const source = protocolSource('usdc'), spec = { source, first: 1, last: 50, anchorHash: '0x' + '1'.repeat(64), registryDigest: hash(source) };
let checks = 0;
const test = (name, f) => { f(); checks++; console.log('PASS ' + name); };
try {
  const u = p.defineUnit(spec, { chunkBlocks: 25 }), j = p.claim({ unitId: u });
  const summary = { format: 'arc-reduced-source-v1', sourceKey: hash(source), anchorHash: spec.anchorHash,
    first: 1, last: 25, inputSha256: hash('verified'), status: 'verified', reason: null, counts: {}, rows: [] };
  p.accept(j, summary);
  const failed = p.claim({ unitId: u }); p.defer(failed, 'recovery_response_budget_exhausted', null);
  const accepted = p.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE state='complete'").get();
  test('refinement changes only unaccepted leaves and keeps parent failure evidence', () => {
    const result = refineProtocolPlan(p, u, { family: 'usdc', maxBlocks: 4 }); assert.equal(result.addedLeaves, 7);
    assert.deepEqual(p.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE state='complete'").get(), accepted);
    assert.equal(p.db.prepare('SELECT reason FROM arc_pipeline_jobs WHERE job_id=?').get(failed.job_id).reason, 'recovery_response_budget_exhausted');
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_failures').get().n, 1);
    const pieces = p.db.prepare("SELECT first_block,last_block FROM arc_pipeline_jobs WHERE state='pending' ORDER BY first_block").all();
    let next = 26; for (const r of pieces) { assert.equal(r.first_block, next); next = r.last_block + 1; } assert.equal(next, 51);
    assert.equal(p.coverage(u).status, 'partial');
  });
  test('plan refinement is idempotent and issues no RPC', () => assert.deepEqual(refineProtocolPlan(p, u, { family: 'usdc', maxBlocks: 4 }),
    { splitParents: 0, addedLeaves: 0, rpcRequests: 0, acceptedResultsChanged: false }));
  test('source mismatch fails before changing any jobs', () => assert.throws(() => refineProtocolPlan(p, u, { family: 'gateway' }), e => e.code === 'protocol_plan_source_conflict'));
  test('repair leaves retaining accepted expected checksums cannot be split', () => {
    p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(accepted.result_sha); p.audit();
    refineProtocolPlan(p, u, { family: 'usdc', maxBlocks: 1 });
    assert.equal(p.db.prepare('SELECT state FROM arc_pipeline_jobs WHERE job_id=?').get(accepted.job_id).state, 'pending');
    assert.equal(p.db.prepare('SELECT expected_sha FROM arc_pipeline_jobs WHERE job_id=?').get(accepted.job_id).expected_sha, accepted.expected_sha);
  });
} finally { p.close(); }
console.log(JSON.stringify({ checks, scope: 'bounded plan safety', productionAccess: false }));
