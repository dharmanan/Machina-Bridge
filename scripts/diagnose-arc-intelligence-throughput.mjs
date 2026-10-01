// A2.7 READ-ONLY production throughput diagnosis for the A2 receipt/log pipeline.
// Usage (operator machine, never in CI):  DATABASE_URL=... node scripts/diagnose-arc-intelligence-throughput.mjs
// Every statement runs inside one READ ONLY transaction with a statement timeout, and the transaction is rolled back.
// No INSERT/UPDATE/DELETE/DDL/VACUUM, no extensions, no settings changes. Output is JSON on stdout.
// Hot-statement plans are plan-only by default: EXPLAIN (FORMAT JSON) never executes the statement.
// Actual timings require explicit operator opt-in, ARC_A27_EXPLAIN_ANALYZE=1, which then runs EXPLAIN (ANALYZE, BUFFERS)
// on the same plain SELECTs. Nothing here takes row locks (no FOR UPDATE inside READ ONLY).
import pg from 'pg';
import { RECEIPT_IDENTITY } from '../server/arc-intelligence/receipt-repository.js';
import { identityValues } from '../server/arc-intelligence/foundation.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';

const STATEMENT_TIMEOUT_MS = 30000;
const ANALYZE = process.env.ARC_A27_EXPLAIN_ANALYZE === '1';
const EXPLAIN = ANALYZE ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)' : 'EXPLAIN (FORMAT JSON)';
const SAMPLE_BLOCKS = 500;
const RECENT_HOURS = 30;
const lane = identityValues(RECEIPT_IDENTITY);
const laneWhere = 'chain_id=$1 AND lane=$2 AND scope_id=$3 AND epoch=$4 AND definition_version=$5';

const sections = {
  queue_by_component_state: [`SELECT component,state,count(*)::int AS jobs,min(start_block) AS oldest_block,max(start_block) AS newest_block,
      min(created_at) AS oldest_created,max(created_at) AS newest_created,max(attempts) AS max_attempts
    FROM arc_intelligence_work WHERE ${laneWhere} GROUP BY 1,2 ORDER BY 1,2`,lane],
  incomplete_attempts_by_component: [`SELECT component,CASE WHEN attempts=0 THEN '0' WHEN attempts=1 THEN '1' WHEN attempts=2 THEN '2'
      WHEN attempts<=5 THEN '3-5' WHEN attempts<=10 THEN '6-10' ELSE '>10' END AS attempts,count(*)::int AS jobs
    FROM arc_intelligence_work WHERE ${laneWhere} AND state<>'complete' GROUP BY 1,2 ORDER BY 1,2`,lane],
  incomplete_reason_codes: [`SELECT component,state,coalesce(reason_code,'none') AS reason_code,count(*)::int AS jobs
    FROM arc_intelligence_work WHERE ${laneWhere} AND state<>'complete' GROUP BY 1,2,3 ORDER BY 1,2,3`,lane],
  incomplete_age_by_component: [`SELECT component,count(*)::int AS incomplete,
      count(*) FILTER (WHERE created_at < now()-interval '15 minutes')::int AS older_than_15m,
      count(*) FILTER (WHERE created_at < now()-interval '1 hour')::int AS older_than_1h,
      count(*) FILTER (WHERE created_at < now()-interval '6 hours')::int AS older_than_6h,
      count(*) FILTER (WHERE not_before > now())::int AS backing_off,
      count(*) FILTER (WHERE state='leased' AND lease_until <= now())::int AS expired_leases
    FROM arc_intelligence_work WHERE ${laneWhere} AND state<>'complete' GROUP BY 1 ORDER BY 1`,lane],
  oldest_and_newest_incomplete: [`(SELECT DISTINCT ON (component) 'oldest' AS edge,component,start_block,state,attempts,created_at,not_before
      FROM arc_intelligence_work WHERE ${laneWhere} AND state<>'complete' ORDER BY component,start_block,id)
    UNION ALL (SELECT DISTINCT ON (component) 'newest',component,start_block,state,attempts,created_at,not_before
      FROM arc_intelligence_work WHERE ${laneWhere} AND state<>'complete' ORDER BY component,start_block DESC,id DESC)`,lane],
  lanes: [`SELECT lane,scope_id,status,origin_block,processed_through,contiguous_complete_through,observed_head,current_error_code,updated_at
    FROM arc_intelligence_lanes WHERE chain_id=$1 ORDER BY lane`,[lane[0]]],
  // A: chain manifest; B/C/D: per-component evidence; E: all three. Holes are explicit: first missing vs last present.
  evidence_frontiers: [`SELECT count(*)::int AS durable_blocks,min(block_number) AS first_block,max(block_number) AS last_block,
      max(block_number) FILTER (WHERE transactions_complete) AS chain_latest,
      max(block_number) FILTER (WHERE receipt_complete) AS receipts_latest,
      min(block_number) FILTER (WHERE NOT receipt_complete) AS receipts_first_hole,
      max(block_number) FILTER (WHERE all_log_reconciliation_complete) AS all_logs_latest,
      min(block_number) FILTER (WHERE NOT all_log_reconciliation_complete) AS all_logs_first_hole,
      max(block_number) FILTER (WHERE transfer_log_reconciliation_complete) AS transfer_logs_latest,
      min(block_number) FILTER (WHERE NOT transfer_log_reconciliation_complete) AS transfer_logs_first_hole,
      min(block_number) FILTER (WHERE NOT (receipt_complete AND all_log_reconciliation_complete AND transfer_log_reconciliation_complete)) AS combined_first_hole,
      count(*) FILTER (WHERE NOT receipt_complete)::int AS blocks_missing_receipts,
      count(*) FILTER (WHERE receipt_complete AND NOT all_log_reconciliation_complete)::int AS blocks_missing_all_logs,
      count(*) FILTER (WHERE receipt_complete AND NOT transfer_log_reconciliation_complete)::int AS blocks_missing_transfer_logs,
      count(*) FILTER (WHERE receipt_evidence_conflict)::int AS conflict_blocks
    FROM arc_intelligence_blocks WHERE chain_id=$1`,[lane[0]]],
  // Which component holds back each recent verified hour.
  recent_hour_completeness: [`SELECT to_timestamp(floor(timestamp/3600)*3600) AS hour,count(*)::int AS blocks,
      count(*) FILTER (WHERE receipt_complete)::int AS receipts,count(*) FILTER (WHERE all_log_reconciliation_complete)::int AS all_logs,
      count(*) FILTER (WHERE transfer_log_reconciliation_complete)::int AS transfer_logs,min(block_number) AS first_block,max(block_number) AS last_block
    FROM arc_intelligence_blocks WHERE chain_id=$1 AND timestamp >= extract(epoch FROM now())::bigint-$2*3600
    GROUP BY 1 ORDER BY 1`,[lane[0],RECENT_HOURS]],
  // Receipt-complete blocks whose missing log component has no durable work row: these wait for the deferred pager.
  deferred_followup_orphans: [`SELECT count(*) FILTER (WHERE NOT b.all_log_reconciliation_complete AND w_all.id IS NULL)::int AS all_logs_without_job,
      count(*) FILTER (WHERE NOT b.transfer_log_reconciliation_complete AND w_transfer.id IS NULL)::int AS transfer_logs_without_job,
      min(b.block_number) AS first_orphan_block,max(b.block_number) AS last_orphan_block
    FROM arc_intelligence_blocks b
    LEFT JOIN arc_intelligence_work w_all ON w_all.chain_id=$1 AND w_all.lane=$2 AND w_all.scope_id=$3 AND w_all.epoch=$4
      AND w_all.definition_version=$5 AND w_all.component='all_logs' AND w_all.logical_key=b.block_hash
    LEFT JOIN arc_intelligence_work w_transfer ON w_transfer.chain_id=$1 AND w_transfer.lane=$2 AND w_transfer.scope_id=$3 AND w_transfer.epoch=$4
      AND w_transfer.definition_version=$5 AND w_transfer.component='transfer_logs' AND w_transfer.logical_key=b.block_hash
    WHERE b.chain_id=$1 AND b.receipt_complete AND NOT b.receipt_evidence_conflict
      AND ((NOT b.all_log_reconciliation_complete AND w_all.id IS NULL) OR (NOT b.transfer_log_reconciliation_complete AND w_transfer.id IS NULL))`,lane],
  // Work cost per block from the most recent fully evidenced blocks.
  work_cost_sample: [`WITH sample AS (SELECT block_number,transaction_count FROM arc_intelligence_blocks WHERE chain_id=$1
        AND receipt_complete AND all_log_reconciliation_complete AND transfer_log_reconciliation_complete ORDER BY block_number DESC LIMIT $2)
    SELECT count(*)::int AS blocks,sum(transaction_count)::int AS transactions,min(block_number) AS first_block,max(block_number) AS last_block,
      (SELECT count(*) FROM arc_intelligence_receipts r WHERE r.chain_id=$1 AND r.block_number IN (SELECT block_number FROM sample))::int AS receipts,
      (SELECT count(*) FROM arc_intelligence_logs l WHERE l.chain_id=$1 AND l.block_number IN (SELECT block_number FROM sample))::int AS logs,
      (SELECT count(*) FROM arc_intelligence_logs l WHERE l.chain_id=$1 AND l.block_number IN (SELECT block_number FROM sample)
        AND l.topics[1]=$3)::int AS transfer_topic_logs,
      (SELECT count(*) FROM arc_intelligence_blocks x WHERE x.chain_id=$1 AND x.block_number IN (SELECT block_number FROM sample)
        AND x.transaction_count=0)::int AS empty_blocks
    FROM sample`,[lane[0],SAMPLE_BLOCKS,TRANSFER_TOPIC]],
  metric_buckets: [`SELECT coverage_status,complete,count(*)::int AS hours,min(to_timestamp(bucket_start)) AS first_hour,max(to_timestamp(bucket_start)) AS last_hour
    FROM arc_intelligence_metric_buckets WHERE chain_id=$1 AND period='hour' GROUP BY 1,2 ORDER BY 1,2`,[lane[0]]],
  table_stats: [`SELECT relname,n_live_tup::bigint,n_dead_tup::bigint,seq_scan::bigint,idx_scan::bigint,n_tup_ins::bigint,n_tup_upd::bigint,
      n_tup_del::bigint,n_tup_hot_upd::bigint,last_autovacuum,last_autoanalyze,pg_total_relation_size(relid)::bigint AS total_bytes
    FROM pg_stat_user_tables WHERE relname LIKE 'arc_intelligence_%' ORDER BY relname`,[]],
  activity: [`SELECT state,coalesce(wait_event_type,'none') AS wait_event_type,coalesce(wait_event,'none') AS wait_event,count(*)::int AS sessions,
      max(now()-query_start) AS longest_running
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY 1,2,3 ORDER BY 4 DESC`,[]],
};

// The hot statements as the runtime issues them (row locks removed; READ ONLY). Plan-only unless ANALYZE opt-in.
const explains = {
  work_count_global: [`SELECT count(*) AS count FROM arc_intelligence_work WHERE state <> 'complete'`,[]],
  work_pressure_lane: [`SELECT count(*) AS outstanding FROM arc_intelligence_work WHERE ${laneWhere} AND state <> 'complete'`,lane],
  progress_retry_count: [`SELECT count(*) AS count FROM arc_intelligence_work
    WHERE ${laneWhere} AND (state='retrying' OR (state='leased' AND reason_code IS NOT NULL))`,lane],
  claim_candidate: [`SELECT id FROM arc_intelligence_work WHERE ${laneWhere} AND not_before <= now()
      AND (state IN ('pending','retrying') OR (state='leased' AND lease_until <= now()))
    ORDER BY CASE WHEN component=$6 THEN 0 ELSE 1 END,not_before,id LIMIT 1`,[...lane,'receipts']],
  prune_boundary: [`SELECT id FROM arc_intelligence_work WHERE state='complete' ORDER BY id DESC OFFSET 999 LIMIT 1`,[]],
  reducer_candidates_pre_a27: [`SELECT (floor(timestamp / 3600)::bigint * 3600) AS bucket_start FROM arc_intelligence_blocks
    WHERE chain_id=$1 AND timestamp < extract(epoch FROM date_trunc('hour',now()))::bigint GROUP BY 1`,[lane[0]]],
  reducer_candidates_a27_bounds: [`SELECT (SELECT timestamp FROM arc_intelligence_blocks WHERE chain_id=$1 ORDER BY timestamp,block_number LIMIT 1),
      (SELECT timestamp FROM arc_intelligence_blocks WHERE chain_id=$1 ORDER BY timestamp DESC,block_number DESC LIMIT 1)`,[lane[0]]],
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('ARC_A27_DIAGNOSIS: FAIL database_url_required'); process.exitCode = 1; return; }
  const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, max:1, connectionTimeoutMillis:10000 });
  // Never print upstream errors verbatim: they can contain connection details.
  pool.on('error', () => {});
  const client = await pool.connect();
  const report = { generatedAt:new Date().toISOString(), readOnly:true,
    explainMode:ANALYZE ? 'analyze' : 'plan_only', analyzeEnabled:ANALYZE, sections:{}, explain:{} };
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    for (const [name,[sql,values]] of Object.entries(sections)) {
      try { report.sections[name] = (await client.query(sql,values)).rows; }
      catch (error) { report.sections[name] = { error:error.code ?? 'query_failed' }; await client.query('ROLLBACK');
        await client.query('BEGIN READ ONLY'); await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`); }
    }
    for (const [name,[sql,values]] of Object.entries(explains)) {
      try {
        const plan = (await client.query(`${EXPLAIN} ${sql}`,values)).rows[0]['QUERY PLAN'][0];
        report.explain[name] = { node:plan.Plan['Node Type'], estimatedRows:plan.Plan['Plan Rows'], estimatedTotalCost:plan.Plan['Total Cost'],
          ...(ANALYZE ? { executionMs:plan['Execution Time'], planningMs:plan['Planning Time'], actualRows:plan.Plan['Actual Rows'],
            sharedHit:plan.Plan['Shared Hit Blocks'], sharedRead:plan.Plan['Shared Read Blocks'] } : {}) };
      } catch (error) { report.explain[name] = { error:error.code ?? 'explain_failed' }; await client.query('ROLLBACK');
        await client.query('BEGIN READ ONLY'); await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`); }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release(); await pool.end();
  }
  console.log(JSON.stringify(report,(key,value) => typeof value === 'bigint' ? value.toString() : value,2));
}

main().catch(() => { console.error('ARC_A27_DIAGNOSIS: FAIL diagnosis_unavailable'); process.exitCode = 1; });
