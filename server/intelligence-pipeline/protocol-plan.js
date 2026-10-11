// Local, opt-in plan refinement. Accepted results/expected hashes and failed-attempt evidence survive.
import { hash, fail, readDefinition } from './storage.js';
import { protocolSource } from './protocol-source.js';
export function refineProtocolPlan(p, unitId, { family, maxBlocks = 16 } = {}) {
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 500) fail('protocol_plan_invalid');
  const row = p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
  if (!row) fail('unit_missing');
  const spec = JSON.parse(readDefinition(row.unit_json));
  if (hash(spec) !== unitId || hash(spec.source) !== hash(protocolSource(family))) fail('protocol_plan_source_conflict');
  const leaves = p.db.prepare(`SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state IN('pending','retryable')
    AND expected_sha IS NULL AND last_block-first_block+1>? ORDER BY first_block`).all(unitId, maxBlocks);
  if (leaves.length > 4096) fail('protocol_plan_budget');
  const plannedLeaves = leaves.reduce((n, r) => n + Math.ceil((r.last_block - r.first_block + 1) / maxBlocks), 0);
  if (plannedLeaves > 4096) fail('protocol_plan_budget');
  let added = 0;
  p.transaction(() => {
    for (const parent of leaves) {
      for (let first = parent.first_block; first <= parent.last_block; first += maxBlocks) {
        const last = Math.min(parent.last_block, first + maxBlocks - 1), id = hash([unitId, first, last]);
        if (p.db.prepare('SELECT 1 FROM arc_pipeline_jobs WHERE job_id=?').get(id)) fail('protocol_plan_conflict');
        p.db.prepare(`INSERT INTO arc_pipeline_jobs(job_id,unit_id,first_block,last_block,state,priority,parent_id)
          VALUES(?,?,?,?,'pending',?,?)`).run(id, unitId, first, last, parent.priority, parent.job_id); added++;
      }
      // Keep the exact parent and its original failure reason for inspection. No evidence gets deleted.
      p.db.prepare("UPDATE arc_pipeline_jobs SET state='split',lease_token=NULL,lease_until=0 WHERE job_id=? AND state IN('pending','retryable') AND expected_sha IS NULL").run(parent.job_id);
    }
  }, leaves.reduce((n, r) => n + Math.ceil((r.last_block - r.first_block + 1) / maxBlocks) * 512, 0) + 4096);
  return { splitParents: leaves.length, addedLeaves: added, rpcRequests: 0, acceptedResultsChanged: false };
}
