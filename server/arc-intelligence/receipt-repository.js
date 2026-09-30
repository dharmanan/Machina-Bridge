import { pruneCompleteWork } from './work-retention.js';
import { createHash } from 'node:crypto';
import { ARC_CHAIN_ID } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { TRANSFER_TOPIC } from '../../api/_lib/arc-intelligence/usdc.js';
import { CHAIN_IDENTITY, MAX_WORK_ROWS, createFoundationRepository, identityValues, position } from './foundation.js';
import { withTransaction, requireWorkLease } from './a2-db.js';
import { validateReceipt, receiptFact, logFact, normalizedLog, sameFacts } from './receipt-facts.js';

export const RECEIPT_IDENTITY = Object.freeze({ ...CHAIN_IDENTITY,lane:'receipts_logs',scopeId:'canonical_receipts_logs',
  definitionVersion:'arc-receipts-logs-v1' });
const where = 'chain_id=$1 AND lane=$2 AND scope_id=$3 AND epoch=$4 AND definition_version=$5';
const dimensions = { receipts:'receipts',all_logs:'all_log_reconciliation',transfer_logs:'transfer_log_reconciliation' };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function receiptSetComplete(view) {
  return view.block.transactions_complete === true && !view.block.receipt_evidence_conflict
    && view.transactions.length === position(view.block.transaction_count) && view.receipts.length === view.transactions.length
    && view.transactions.every((t,i) => position(t.transaction_index) === i && view.receipts.some((r) =>
      r.transaction_hash === t.transaction_hash && r.block_hash === t.block_hash
      && position(r.block_number) === position(t.block_number) && position(r.transaction_index) === i && ['success','failed'].includes(r.status)));
}

export function createReceiptRepository(pool, identity = RECEIPT_IDENTITY) {
  const foundation = createFoundationRepository(pool);
  const values = identityValues(identity);
  if (identity.lane !== 'receipts_logs' || identity.scopeId !== 'canonical_receipts_logs') throw new Error('invalid_receipt_lane');
  const transaction = (work) => withTransaction(pool,work);
  async function load(client, number, lock = false) {
    const block = (await client.query(`/* receipts:block */ SELECT * FROM arc_intelligence_blocks
      WHERE chain_id=$1 AND block_number=$2${lock ? ' FOR UPDATE' : ''}`,[ARC_CHAIN_ID,number])).rows[0];
    if (!block || block.transactions_complete !== true) throw new Error('chain_facts_unavailable');
    const transactions = (await client.query(`/* receipts:transactions */ SELECT * FROM arc_intelligence_transactions
      WHERE chain_id=$1 AND block_number=$2 ORDER BY transaction_index`,[ARC_CHAIN_ID,number])).rows;
    if (transactions.length !== position(block.transaction_count) || transactions.some((t,i) => position(t.transaction_index) !== i
      || t.block_hash !== block.block_hash)) throw new Error('chain_facts_unavailable');
    const receipts = (await client.query(`/* receipts:receipts */ SELECT * FROM arc_intelligence_receipts
      WHERE chain_id=$1 AND block_number=$2 ORDER BY transaction_index`,[ARC_CHAIN_ID,number])).rows;
    const logs = (await client.query(`/* receipts:logs */ SELECT * FROM arc_intelligence_logs
      WHERE chain_id=$1 AND block_number=$2 ORDER BY log_index`,[ARC_CHAIN_ID,number])).rows;
    const reconciliation = (await client.query(`/* receipts:evidence */ SELECT * FROM arc_intelligence_reconciliation
      WHERE chain_id=$1 AND block_number=$2 AND definition_version=$3`,[ARC_CHAIN_ID,number,identity.definitionVersion])).rows;
    return { block,transactions,receipts,logs,reconciliation };
  }
  async function guard(client, lease) {
    const job = await requireWorkLease(client,lease);
    if (values.some((value,i) => value !== [job.chain_id,job.lane,job.scope_id,job.epoch,job.definition_version][i])
      || !Object.hasOwn(dimensions,job.component) || position(job.start_block) !== position(job.end_block)) throw new Error('work_identity_mismatch');
    const state = (await client.query(`/* receipts:lane */ SELECT * FROM arc_intelligence_lanes WHERE ${where} FOR UPDATE`,values)).rows[0];
    if (!state || state.status === 'continuity_error') throw new Error('lane_continuity_stopped');
    const view = await load(client,position(job.start_block),true);
    if (job.block_hash !== view.block.block_hash) throw new Error('checkpoint_parent_hash_mismatch');
    if (view.block.receipt_evidence_conflict) throw new Error('receipt_evidence_conflict');
    return { job,view,state };
  }
  async function enqueue(client, block, component) {
    await client.query('SELECT pg_advisory_xact_lock(5042,177004)');
    await pruneCompleteWork(client);
    const existing = (await client.query(`/* a2:work_existing */ SELECT * FROM arc_intelligence_work
      WHERE ${where} AND component=$6 AND logical_key=$7`,[...values,component,block.block_hash])).rows[0];
    if (existing) return existing;
    const count = (await client.query('/* a2:work_count */ SELECT count(*) AS count FROM arc_intelligence_work WHERE state <> \'complete\'')).rows[0].count;
    if (position(count) >= MAX_WORK_ROWS) throw new Error('work_capacity_reached');
    return (await client.query(`/* a2:enqueue */ INSERT INTO arc_intelligence_work
      (chain_id,lane,scope_id,epoch,definition_version,component,logical_key,start_block,end_block,block_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [...values,component,block.block_hash,block.block_number,block.block_number,block.block_hash])).rows[0];
  }
  async function coverage(client, view, component, complete, evidence) {
    await client.query(`/* receipts:coverage */ INSERT INTO arc_intelligence_coverage
      (chain_id,lane,scope_id,epoch,definition_version,start_block,end_block,start_hash,end_hash,coverage_dimension,evidence_digest,state)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$9,$10)
      ON CONFLICT (chain_id,lane,scope_id,epoch,definition_version,coverage_dimension,start_block,end_block)
      DO UPDATE SET state=EXCLUDED.state,evidence_digest=EXCLUDED.evidence_digest,updated_at=now()
      WHERE arc_intelligence_coverage.state <> 'complete'`,
    [...values,view.block.block_number,view.block.block_hash,dimensions[component],digest(evidence),complete ? 'complete' : 'partial']);
  }
  async function progress(client, state, number, ceiling = Math.max(number,state.processed_through === null ? number : position(state.processed_through))) {
    const start = state.contiguous_complete_through === null ? position(state.origin_block) : position(state.contiguous_complete_through)+1;
    const blocks = (await client.query(`/* receipts:advance */ SELECT b.*,
      EXISTS (SELECT 1 FROM arc_intelligence_coverage c WHERE c.chain_id=b.chain_id AND c.lane=$5 AND c.scope_id=$6 AND c.epoch=$7
        AND c.definition_version=$4 AND c.coverage_dimension='receipts' AND c.start_block=b.block_number AND c.end_block=b.block_number
        AND c.state='complete') AS receipt_coverage_complete,
      EXISTS (SELECT 1 FROM arc_intelligence_reconciliation r WHERE r.chain_id=b.chain_id AND r.block_number=b.block_number
        AND r.kind='all_logs' AND r.definition_version=$4 AND r.complete) AS all_evidence_complete,
      EXISTS (SELECT 1 FROM arc_intelligence_reconciliation r WHERE r.chain_id=b.chain_id AND r.block_number=b.block_number
        AND r.kind='transfer_logs' AND r.definition_version=$4 AND r.complete) AS transfer_evidence_complete
      FROM arc_intelligence_blocks b WHERE chain_id=$1 AND block_number BETWEEN $2 AND $8 ORDER BY block_number LIMIT $3`,
    [ARC_CHAIN_ID,start,MAX_WINDOW_SIZE,identity.definitionVersion,identity.lane,identity.scopeId,identity.epoch,ceiling])).rows;
    let through = state.contiguous_complete_through;
    let checkpointHash = state.checkpoint_hash;
    let previousHash = checkpointHash ?? state.anchor_hash;
    let advanced = 0;
    for (let i=0;i<blocks.length;i++) {
      const b=blocks[i];
      if (position(b.block_number) !== start+i || !b.transactions_complete || !b.receipt_complete
        || !b.all_log_reconciliation_complete || !b.transfer_log_reconciliation_complete || b.receipt_evidence_conflict
        || !b.receipt_coverage_complete || !b.all_evidence_complete || !b.transfer_evidence_complete) break;
      if (previousHash && previousHash !== b.parent_hash) throw new Error('checkpoint_parent_hash_mismatch');
      advanced++;
      through=position(b.block_number); checkpointHash=b.block_hash; previousHash=b.block_hash;
    }
    const processed = Math.max(state.processed_through === null ? -1 : position(state.processed_through),number,through ?? -1);
    const retry = (await client.query(`/* receipts:retry_count */ SELECT count(*) AS count FROM arc_intelligence_work
      WHERE ${where} AND (state='retrying' OR (state='leased' AND reason_code IS NOT NULL))`,values)).rows[0].count;
    const conflicts = (await client.query(`/* receipts:conflict_count */ SELECT count(*) AS count FROM arc_intelligence_work
      WHERE ${where} AND state='persistent_partial' AND reason_code='manifest_conflict'`,values)).rows[0].count;
    const status = position(conflicts) > 0 ? 'persistent_partial' : position(retry) > 0 ? 'retrying' : through === processed ? 'caught_up' : 'indexing';
    await client.query(`/* receipts:progress */ UPDATE arc_intelligence_lanes SET processed_through=$6,
      contiguous_complete_through=$7,checkpoint_hash=$8,status=$9,current_error_code=$10,last_success_at=now(),updated_at=now() WHERE ${where}`,
    [...values,processed,through,checkpointHash,status,status === 'persistent_partial' ? 'manifest_conflict' : status === 'retrying' ? 'required_read_unavailable' : null]);
    return {more:advanced === MAX_WINDOW_SIZE && position(through) < ceiling,ceiling};
  }
  async function finish(client, job, complete, retryMs) {
    await client.query(`/* a2:result */ UPDATE arc_intelligence_work SET state=$2,reason_code=$3,
      not_before=now()+$4*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
    [job.id,complete ? 'complete' : 'retrying',complete ? null : 'required_read_unavailable',retryMs]);
    if (complete) await pruneCompleteWork(client);
  }
  async function saveReceipt(client, normalized, view, durableHashes, durableLogIndexes) {
    const fact=receiptFact(normalized);
    const existing=view.receipts.find((r) => r.transaction_hash === fact.transaction_hash);
    const logs=normalized.logs.map(logFact);
    if (existing) {
      const previous=view.logs.filter((l) => l.transaction_hash === fact.transaction_hash);
      if (!sameFacts(existing,fact) || previous.length !== logs.length || logs.some((l,i) => !sameFacts(previous[i],l))) throw new Error(durableHashes.has(fact.transaction_hash) ? 'receipt_evidence_conflict' : 'receipt_response_conflict');
      return;
    }
    for (const l of logs) {
      const previous=view.logs.find((p) => position(p.log_index) === l.log_index);
      if (previous && !sameFacts(previous,l)) throw new Error(durableLogIndexes.has(l.log_index) ? 'receipt_evidence_conflict' : 'receipt_response_conflict');
    }
    await client.query(`/* receipts:insert_receipt */ INSERT INTO arc_intelligence_receipts
      (chain_id,block_number,block_hash,transaction_index,transaction_hash,status,gas_used_raw,effective_gas_price_raw,contract_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,Object.values(fact));
    for (const log of logs) await client.query(`/* receipts:insert_log */ INSERT INTO arc_intelligence_logs
      (chain_id,block_number,block_hash,transaction_index,transaction_hash,log_index,address,topics,data,removed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (chain_id,block_number,log_index) DO NOTHING`,Object.values(log));
    view.receipts.push(fact); view.logs.push(...logs); view.logs.sort((a,b) => position(a.log_index)-position(b.log_index));
  }
  async function advanceFrontier() {
    let ceiling;
    let more;
    try {
      do {
        more = await transaction(async (client) => {
          const state = (await client.query(`/* receipts:lane */ SELECT * FROM arc_intelligence_lanes WHERE ${where} FOR UPDATE`,values)).rows[0];
          if (!state || state.status === 'continuity_error' || state.processed_through === null) return false;
          ceiling ??= position(state.processed_through);
          // Each transaction examines at most 50 indexed rows; the fixed ceiling prevents chasing new work indefinitely.
          return (await progress(client,state,position(state.processed_through),ceiling)).more;
        });
      } while (more);
    } catch (error) {
      if (error.message === 'checkpoint_parent_hash_mismatch') {
        await foundation.setLaneStatus(identity,'continuity_error','checkpoint_parent_hash_mismatch');
        throw new Error('lane_continuity_stopped');
      }
      throw error;
    }
  }
  async function commitAndAdvance(work) {
    const result = await transaction(work);
    await advanceFrontier();
    return result;
  }
  return {
    identity,
    advanceFrontier,
    async initialize() { return foundation.initializeLane(identity); },
    async getLane() { return foundation.getLane(identity); },
    async getBlock(number) {
      const client=await pool.connect();
      try { return await load(client,position(number)); } finally { client.release(); }
    },
    async recentIncompleteBlocks(through, tailSize = MAX_WINDOW_SIZE) {
      const end = position(through);
      if (!Number.isSafeInteger(tailSize) || tailSize < 1 || tailSize > MAX_WINDOW_SIZE) throw new Error('invalid_recent_tail');
      // No anchor-to-head scan: both the numeric range and returned rows are bounded.
      return (await pool.query(`/* receipts:recent */ SELECT block_number FROM arc_intelligence_blocks
        WHERE chain_id=$1 AND block_number BETWEEN $2 AND $3 AND transactions_complete
        AND NOT receipt_evidence_conflict
        AND NOT (receipt_complete AND all_log_reconciliation_complete AND transfer_log_reconciliation_complete)
        ORDER BY block_number LIMIT $4`,[ARC_CHAIN_ID,Math.max(0,end-tailSize+1),end,tailSize])).rows.map((b) => position(b.block_number));
    },
    async scheduleBlock(number) {
      await this.initialize();
      return commitAndAdvance(async (client) => {
        const view=await load(client,position(number),true);
        if (view.block.receipt_evidence_conflict) throw new Error('receipt_evidence_conflict');
        const jobs=[];
        if (!view.block.receipt_complete || !receiptSetComplete(view)) jobs.push(await enqueue(client,view.block,'receipts'));
        else {
          for (const component of ['all_logs','transfer_logs']) {
            if (!view.reconciliation.some((r) => r.kind === component && r.complete)) jobs.push(await enqueue(client,view.block,component));
          }
        }
        return jobs;
      });
    },
    async claim(owner,leaseMs=180000, { preferredComponent = null } = {}) {
      if (preferredComponent !== null && !Object.hasOwn(dimensions,preferredComponent)) throw new Error('invalid_receipt_component');
      return foundation.claim(identity,owner,leaseMs,{preferredComponent});
    },
    async claimLogBatch(firstLease,maxBlocks=10,leaseMs=180000) {
      if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_WINDOW_SIZE
        || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new Error('invalid_log_batch');
      return transaction(async (client) => {
        const first=await requireWorkLease(client,firstLease);
        if (values.some((v,i) => v !== [first.chain_id,first.lane,first.scope_id,first.epoch,first.definition_version][i])
          || !['all_logs','transfer_logs'].includes(first.component)
          || position(first.start_block) !== position(first.end_block)) throw new Error('work_identity_mismatch');
        const start=position(first.start_block);
        const end=start+Math.min(maxBlocks-1,Number.MAX_SAFE_INTEGER-start);
        // The existing single claim selects priority/fallback. Extend only that component and bounded numeric span.
        const jobs=maxBlocks===1 ? [] : (await client.query(`/* receipts:claim_logs */ WITH candidates AS (
          SELECT id FROM arc_intelligence_work WHERE ${where} AND component=$8
            AND start_block BETWEEN $9 AND $10 AND end_block=start_block AND not_before <= now()
            AND (state IN ('pending','retrying') OR (state='leased' AND lease_until <= now()))
          ORDER BY start_block,not_before,id LIMIT $11 FOR UPDATE SKIP LOCKED
        ) UPDATE arc_intelligence_work w SET state='leased',attempts=w.attempts+1,
          fencing_token=w.fencing_token+1,lease_owner=$6,lease_until=now()+$7*interval '1 millisecond',updated_at=now()
          FROM candidates c WHERE w.id=c.id RETURNING w.*`,
        [...values,first.lease_owner,leaseMs,first.component,start,end,maxBlocks-1])).rows;
        return [first,...jobs].sort((a,b) => position(a.start_block)-position(b.start_block)
          || (BigInt(a.id)<BigInt(b.id) ? -1 : 1));
      });
    },
    async deferredFollowupBlocks(startBlock=0,limit=MAX_WINDOW_SIZE) {
      const start=position(startBlock);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WINDOW_SIZE) throw new Error('invalid_deferred_limit');
      // Page the canonical manifest PK, not just recent blocks. At most 50 rows and two components per row are examined.
      const rows=(await pool.query(`/* receipts:deferred */ WITH bounded AS (
        SELECT * FROM arc_intelligence_blocks WHERE chain_id=$1 AND block_number >= $6 ORDER BY block_number LIMIT $7
      ) SELECT b.block_number,
        (b.transactions_complete AND b.receipt_complete AND NOT b.receipt_evidence_conflict AND EXISTS (
          SELECT 1 FROM (VALUES ('all_logs'),('transfer_logs')) AS component(kind)
          WHERE NOT EXISTS (SELECT 1 FROM arc_intelligence_reconciliation r WHERE r.chain_id=b.chain_id AND r.block_number=b.block_number
            AND r.block_hash=b.block_hash AND r.kind=component.kind AND r.definition_version=$5 AND r.complete)
          AND NOT EXISTS (SELECT 1 FROM arc_intelligence_work w WHERE w.chain_id=$1 AND w.lane=$2 AND w.scope_id=$3 AND w.epoch=$4
            AND w.definition_version=$5 AND w.component=component.kind AND w.logical_key=b.block_hash)
        )) AS needs_followups FROM bounded b ORDER BY b.block_number`,[...values,start,limit])).rows;
      return {blocks:rows.filter((b) => b.needs_followups).map((b) => position(b.block_number)),scanned:rows.length,
        nextBlock:rows.length===limit ? position(rows.at(-1).block_number)+1 : 0};
    },
    async recoverDeferredFollowups(number) {
      return transaction(async (client) => {
        const view=await load(client,position(number),true);
        if (!view.block.receipt_complete || !receiptSetComplete(view)) return [];
        const jobs=[];
        for (const component of ['all_logs','transfer_logs']) {
          if (view.reconciliation.some((r) => r.kind===component && r.complete)) continue;
          const existing=(await client.query(`/* a2:work_existing */ SELECT * FROM arc_intelligence_work
            WHERE ${where} AND component=$6 AND logical_key=$7`,[...values,component,view.block.block_hash])).rows[0];
          if (!existing) jobs.push(await enqueue(client,view.block,component));
        }
        return jobs;
      });
    },
    async capacityBelow(highWater) {
      const count=(await pool.query("/* a2:work_count */ SELECT count(*) AS count FROM arc_intelligence_work WHERE state <> 'complete'")).rows[0].count;
      return position(count) < highWater;
    },
    async workPressure() {
      // Same capacity predicate as enqueue, scoped to this exact receipt lane identity.
      const result = (await pool.query(`/* receipts:work_pressure */ SELECT count(*) AS outstanding
        FROM arc_intelligence_work WHERE ${where} AND state <> 'complete'`,values)).rows[0];
      return {outstanding:position(result.outstanding)};
    },
    async workCounts() {
      // The ready-state predicate matches the existing partial work index; outstanding work is capped at 10000.
      const counts = (await pool.query(`/* receipts:work_counts */ SELECT
        count(*) FILTER (WHERE state='pending') AS pending,
        count(*) FILTER (WHERE state='retrying') AS retrying,
        count(*) FILTER (WHERE state='leased') AS leased
        FROM arc_intelligence_work WHERE ${where} AND state IN ('pending','retrying','leased')`,values)).rows[0];
      return {pending:position(counts.pending),retrying:position(counts.retrying),leased:position(counts.leased)};
    },
    async markBulkAttempted(lease) {
      return transaction(async (client) => {
        const {job,view}=await guard(client,lease);
        if (job.component !== 'receipts') throw new Error('work_identity_mismatch');
        if (view.receipts.length || view.block.receipt_bulk_attempted) return false;
        await client.query(`/* receipts:bulk_attempted */ UPDATE arc_intelligence_blocks SET receipt_bulk_attempted=true
          WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,view.block.block_number]);
        return true;
      });
    },
    async saveReceipts(lease,rawReceipts,{ retryMs=1000,finalize=true,enqueueFollowups=true }={}) {
      return commitAndAdvance(async (client) => {
        const {job,view,state}=await guard(client,lease);
        if (job.component !== 'receipts') throw new Error('work_identity_mismatch');
        const durableHashes=new Set(view.receipts.map((r) => r.transaction_hash));
        const durableLogIndexes=new Set(view.logs.map((l) => position(l.log_index)));
        for (const raw of rawReceipts) await saveReceipt(client,validateReceipt(raw,view),view,durableHashes,durableLogIndexes);
        const complete=receiptSetComplete(view);
        await client.query(`/* receipts:certify */ UPDATE arc_intelligence_blocks
          SET receipt_count=CASE WHEN $3 THEN $4 ELSE receipt_count END,receipt_complete=receipt_complete OR $3
          WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,view.block.block_number,complete,view.receipts.length]);
        await coverage(client,view,'receipts',complete,view.receipts);
        if (complete && enqueueFollowups) for (const component of ['all_logs','transfer_logs']) {
          if (!view.reconciliation.some((r) => r.kind === component && r.complete)) await enqueue(client,view.block,component);
        }
        if (finalize) await finish(client,job,complete,retryMs);
        await progress(client,state,position(view.block.block_number));
        return { complete,receiptCount:view.receipts.length,missingCount:view.transactions.length-view.receipts.length };
      });
    },
    async saveReconciliation(lease,evidence,retryMs=1000) {
      return commitAndAdvance(async (client) => {
        const {job,view,state}=await guard(client,lease);
        if (!['all_logs','transfer_logs'].includes(job.component) || !receiptSetComplete(view)) throw new Error('work_identity_mismatch');
        const old=view.reconciliation.find((r) => r.kind === job.component);
        // A completed certificate is immutable across retries; never overwrite it with a failed query.
        let complete=old?.complete === true;
        if (!complete) {
          const transfer=job.component === 'transfer_logs';
          const receiptCount=evidence[transfer ? 'receiptTransferLogCount' : 'receiptLogCount'];
          const queriedCount=evidence[transfer ? 'queriedTransferLogCount' : 'queriedLogCount'];
          const expected=view.logs.filter((l) => !transfer || l.topics[0] === TRANSFER_TOPIC).length;
          if (receiptCount !== expected || evidence.receiptSetComplete !== true) throw new Error('invalid_reconciliation_evidence');
          complete=evidence.complete === true;
          if (complete && (!evidence.queryComplete || queriedCount !== receiptCount || [evidence.missingLogCount,evidence.extraLogCount,
            evidence.duplicateReceiptLogCount,evidence.duplicateQueryLogCount,evidence.identitylessReceiptLogCount,
            evidence.identitylessQueryLogCount,evidence.payloadMismatchCount].some((n) => n !== 0))) throw new Error('invalid_reconciliation_evidence');
          await client.query(`/* receipts:reconciliation */ INSERT INTO arc_intelligence_reconciliation
            (chain_id,block_number,block_hash,kind,definition_version,receipt_log_count,queried_log_count,missing_count,extra_count,
             duplicate_receipt_count,duplicate_query_count,identityless_receipt_count,identityless_query_count,payload_mismatch_count,
             query_complete,complete,evidence_digest,reason_code)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            ON CONFLICT (chain_id,block_number,kind,definition_version) DO UPDATE SET
              queried_log_count=EXCLUDED.queried_log_count,missing_count=EXCLUDED.missing_count,extra_count=EXCLUDED.extra_count,
              duplicate_query_count=EXCLUDED.duplicate_query_count,identityless_query_count=EXCLUDED.identityless_query_count,
              payload_mismatch_count=EXCLUDED.payload_mismatch_count,query_complete=EXCLUDED.query_complete,
              complete=EXCLUDED.complete,evidence_digest=EXCLUDED.evidence_digest,reason_code=EXCLUDED.reason_code,updated_at=now()
            WHERE NOT arc_intelligence_reconciliation.complete`,
          [ARC_CHAIN_ID,view.block.block_number,view.block.block_hash,job.component,identity.definitionVersion,receiptCount,queriedCount,
            evidence.missingLogCount,evidence.extraLogCount,evidence.duplicateReceiptLogCount,evidence.duplicateQueryLogCount,
            evidence.identitylessReceiptLogCount,evidence.identitylessQueryLogCount,evidence.payloadMismatchCount,
            evidence.queryComplete,complete,digest({blockHash:view.block.block_hash,evidence}),
            complete ? null : evidence.queryComplete ? 'log_reconciliation_incomplete' : 'query_unavailable']);
          const column=job.component === 'all_logs' ? 'all_log_reconciliation_complete' : 'transfer_log_reconciliation_complete';
          await client.query(`/* receipts:log_certify */ UPDATE arc_intelligence_blocks SET ${column}=${column} OR $3
            WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,view.block.block_number,complete]);
          await coverage(client,view,job.component,complete,evidence);
        }
        await finish(client,job,complete,retryMs); await progress(client,state,position(view.block.block_number));
        return {complete};
      });
    },
    async recordConflict(lease) {
      return transaction(async (client) => {
        const job=await requireWorkLease(client,lease);
        if (values.some((v,i) => v !== [job.chain_id,job.lane,job.scope_id,job.epoch,job.definition_version][i])) throw new Error('work_identity_mismatch');
        const state=(await client.query(`/* receipts:lane */ SELECT * FROM arc_intelligence_lanes WHERE ${where} FOR UPDATE`,values)).rows[0];
        const view=await load(client,position(job.start_block),true);
        if (!state || state.status === 'continuity_error') throw new Error('lane_continuity_stopped');
        if (job.block_hash !== view.block.block_hash) throw new Error('checkpoint_parent_hash_mismatch');
        // In this A2 lane, manifest_conflict is the bounded code for a conflict against durable receipt/log evidence.
        // Preserve canonical facts/certificates, but withdraw their block eligibility while the conflict is unresolved.
        await client.query(`/* receipts:conflict */ UPDATE arc_intelligence_blocks SET receipt_evidence_conflict=true,
          receipt_complete=false,all_log_reconciliation_complete=false,transfer_log_reconciliation_complete=false,core_complete=false
          WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,view.block.block_number]);
        await client.query(`/* receipts:invalidate_coverage */ UPDATE arc_intelligence_coverage SET state='partial',updated_at=now()
          WHERE ${where} AND start_block=$6 AND end_block=$6 AND state='complete'
          AND coverage_dimension IN ('receipts','all_log_reconciliation','transfer_log_reconciliation')`,
        [...values,view.block.block_number]);
        await client.query(`/* a2:result */ UPDATE arc_intelligence_work SET state=$2,reason_code=$3,
          not_before=now()+$4*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [job.id,'persistent_partial','manifest_conflict',0]);
        if (state.contiguous_complete_through !== null && position(state.contiguous_complete_through) >= position(view.block.block_number)) {
          const before=position(view.block.block_number)-1;
          state.contiguous_complete_through=before < position(state.origin_block) ? null : before;
          state.checkpoint_hash=state.contiguous_complete_through === null ? null : view.block.parent_hash;
        }
        await progress(client,state,position(view.block.block_number));
      });
    },
    async recordContinuityError(lease) {
      return transaction(async (client) => {
        const job=await requireWorkLease(client,lease);
        if (values.some((v,i) => v !== [job.chain_id,job.lane,job.scope_id,job.epoch,job.definition_version][i])) throw new Error('work_identity_mismatch');
        await client.query(`/* a2:halt */ UPDATE arc_intelligence_lanes SET status='continuity_error',current_error_code=$6,
          updated_at=now() WHERE ${where}`,[...values,'checkpoint_parent_hash_mismatch']);
        await client.query(`/* a2:result */ UPDATE arc_intelligence_work SET state=$2,reason_code=$3,
          not_before=now()+$4*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [job.id,'failed','checkpoint_parent_hash_mismatch',0]);
      });
    },
    async retry(lease,retryMs=1000) {
      return transaction(async (client) => {
        const {job,view,state}=await guard(client,lease);
        await finish(client,job,false,retryMs); await progress(client,state,position(view.block.block_number));
      });
    },
  };
}
