import { ARC_CHAIN_ID } from '../../api/_lib/arc-intelligence/rpc.js';
import { METRIC_DEFINITION_VERSION } from '../../api/_lib/arc-intelligence/metrics.js';
import { RECEIPT_IDENTITY } from './receipt-repository.js';
import { identityValues,position } from './foundation.js';
import { withTransaction } from './a2-db.js';
import { HOURLY_REDUCER_VERSION,HOUR_SECONDS,RAW_KEEP_SECONDS,MAX_HOURLY_BLOCKS,MAX_HOURLY_FACT_ROWS,
  hourStart,checkAbort,inspectHour,reduceDurableHour } from './hourly-reducer.js';

// Existing chain/time, fact/block and certificate identity indexes service these bounded queries.
const hourSql=`/* metrics:hour */ WITH window_blocks AS (
  (SELECT block_number,'inside'::text AS window_role FROM arc_intelligence_blocks
    WHERE chain_id=$1 AND timestamp >= $6 AND timestamp < $7 ORDER BY timestamp,block_number LIMIT $8)
  UNION ALL
  (SELECT block_number,'before'::text FROM arc_intelligence_blocks WHERE chain_id=$1 AND timestamp < $6
    ORDER BY timestamp DESC,block_number DESC LIMIT 1)
  UNION ALL
  (SELECT block_number,'after'::text FROM arc_intelligence_blocks WHERE chain_id=$1 AND timestamp >= $7
    ORDER BY timestamp,block_number LIMIT 1)
) SELECT b.*,w.window_role,c.evidence_digest AS receipts_digest,
  a.evidence_digest AS all_logs_digest,t.evidence_digest AS transfer_logs_digest
  FROM window_blocks w JOIN arc_intelligence_blocks b ON b.chain_id=$1 AND b.block_number=w.block_number
  LEFT JOIN arc_intelligence_coverage c ON c.chain_id=b.chain_id AND c.lane=$2 AND c.scope_id=$3
    AND c.epoch=$4 AND c.definition_version=$5 AND c.start_block=b.block_number AND c.end_block=b.block_number
    AND c.start_hash=b.block_hash AND c.end_hash=b.block_hash AND c.coverage_dimension='receipts' AND c.state='complete'
  LEFT JOIN arc_intelligence_reconciliation a ON a.chain_id=b.chain_id AND a.block_number=b.block_number
    AND a.block_hash=b.block_hash AND a.kind='all_logs' AND a.definition_version=$5 AND a.complete
  LEFT JOIN arc_intelligence_reconciliation t ON t.chain_id=b.chain_id AND t.block_number=b.block_number
    AND t.block_hash=b.block_hash AND t.kind='transfer_logs' AND t.definition_version=$5 AND t.complete
  ORDER BY b.block_number`;

function rowModel(row) {
  if (!row) return null;
  const n=(value) => value===null ? null : position(value);
  return {chainId:row.chain_id,period:row.period,bucketStart:n(row.bucket_start),bucketEnd:n(row.bucket_end),
    startBlock:n(row.start_block),endBlock:n(row.end_block),startHash:row.start_hash,endHash:row.end_hash,blockCount:n(row.block_count),
    definitionVersion:row.definition_version,reducerVersion:row.reducer_version,coverageStatus:row.coverage_status,
    complete:row.complete,requiredReducersComplete:row.required_reducers_complete,rawPrunable:row.raw_prunable,
    metrics:row.metrics,coverage:row.coverage,evidenceDigest:row.evidence_digest};
}

// Importing/constructing this repository starts no scheduler, opens no network and does not prune raw facts.
export function createMetricRepository(pool) {
  const identity=identityValues(RECEIPT_IDENTITY);
  const key=(start) => [ARC_CHAIN_ID,'hour',hourStart(start),METRIC_DEFINITION_VERSION,HOURLY_REDUCER_VERSION];
  async function readHour(client,start,lock=false) {
    return (await client.query(hourSql+(lock ? ' FOR SHARE OF b' : ''),
      [...identity,start,start+HOUR_SECONDS,MAX_HOURLY_BLOCKS+1])).rows;
  }
  async function get(client,start) {
    return rowModel((await client.query(`/* metrics:bucket */ SELECT * FROM arc_intelligence_metric_buckets
      WHERE chain_id=$1 AND period=$2 AND bucket_start=$3 AND definition_version=$4 AND reducer_version=$5`,key(start))).rows[0]);
  }
  return Object.freeze({
    async getHour(start) { const client=await pool.connect();try {return await get(client,start);} finally {client.release();} },
    async reduceHour({bucketStart,signal}={}) {
      const start=hourStart(bucketStart);checkAbort(signal);
      const client=await pool.connect();let rows,transactions=[],receipts=[];
      try {
        rows=await readHour(client,start);checkAbort(signal);
        if (inspectHour(rows,start).manifestComplete) {
          const numbers=rows.map((b) => position(b.block_number));
          transactions=(await client.query(`/* metrics:transactions */ SELECT * FROM arc_intelligence_transactions
            WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) ORDER BY block_number,transaction_index LIMIT $3`,
          [ARC_CHAIN_ID,numbers,MAX_HOURLY_FACT_ROWS+1])).rows;
          checkAbort(signal);
          receipts=(await client.query(`/* metrics:receipts */ SELECT * FROM arc_intelligence_receipts
            WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) ORDER BY block_number,transaction_index LIMIT $3`,
          [ARC_CHAIN_ID,numbers,MAX_HOURLY_FACT_ROWS+1])).rows;
        }
      } finally {client.release();}
      // CPU reduction and all fact reads occur before the short publishing transaction.
      const bucket=reduceDurableHour({rows,transactions,receipts,start,signal});checkAbort(signal);
      return withTransaction(pool,async (writer) => {
        // Serialise this bucket's writers without touching indexer/work advisory locks.
        await writer.query('/* metrics:lock */ SELECT pg_advisory_xact_lock(5042,hashtext($1))',
          [`hour:${start}:${METRIC_DEFINITION_VERSION}:${HOURLY_REDUCER_VERSION}`]);
        const fresh=await readHour(writer,start,true);checkAbort(signal);
        if (inspectHour(fresh,start).proofDigest!==bucket.proofDigest) throw new Error('metric_evidence_changed');
        // Block SHARE locks prevent receipt conflict/quarantine races during publication across lane epochs.
        const row=(await writer.query(`/* metrics:upsert */ INSERT INTO arc_intelligence_metric_buckets
          (chain_id,period,bucket_start,bucket_end,start_block,end_block,start_hash,end_hash,block_count,
           definition_version,reducer_version,coverage_status,complete,required_reducers_complete,raw_prunable,metrics,coverage,evidence_digest)
          VALUES ($1,'hour',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false,$13::jsonb,$14::jsonb,$15)
          ON CONFLICT (chain_id,period,bucket_start,definition_version,reducer_version) DO UPDATE SET
            start_block=EXCLUDED.start_block,end_block=EXCLUDED.end_block,start_hash=EXCLUDED.start_hash,end_hash=EXCLUDED.end_hash,
            block_count=EXCLUDED.block_count,coverage_status=EXCLUDED.coverage_status,complete=EXCLUDED.complete,
            required_reducers_complete=false,raw_prunable=false,metrics=EXCLUDED.metrics,coverage=EXCLUDED.coverage,
            evidence_digest=EXCLUDED.evidence_digest,updated_at=now()
          WHERE arc_intelligence_metric_buckets.evidence_digest<>EXCLUDED.evidence_digest
          RETURNING *`,[ARC_CHAIN_ID,bucket.bucketStart,bucket.bucketEnd,bucket.startBlock,bucket.endBlock,
          bucket.startHash,bucket.endHash,bucket.blockCount,bucket.definitionVersion,bucket.reducerVersion,bucket.coverageStatus,
          bucket.complete,JSON.stringify(bucket.metrics),JSON.stringify({...bucket.coverage,proofDigest:bucket.proofDigest}),bucket.evidenceDigest])).rows[0];
        checkAbort(signal);
        return row ? rowModel(row) : get(writer,start);
      });
    },
    async retentionDryRun({bucketStart,nowSeconds=Math.floor(Date.now()/1000)}={}) {
      const start=hourStart(bucketStart),now=position(nowSeconds),client=await pool.connect();
      try {
        const bucket=await get(client,start),rows=await readHour(client,start),current=inspectHour(rows,start);
        const blocks=current.inside.slice(0,MAX_HOURLY_BLOCKS),numbers=blocks.map((b) => position(b.block_number));
        const first=blocks[0],last=blocks.at(-1),from=first ? position(first.block_number) : null,to=last ? position(last.block_number) : null;
        const reasons=[];
        if (start+HOUR_SECONDS>now-RAW_KEEP_SECONDS) reasons.push('raw_keep_window');
        if (!bucket) reasons.push('durable_bucket_unavailable');
        else if (!bucket.complete) reasons.push('durable_bucket_incomplete');
        if (!current.manifestComplete) reasons.push('current_block_evidence_incomplete');
        if (bucket && (bucket.coverage.proofDigest!==current.proofDigest || bucket.startBlock!==from || bucket.endBlock!==to
          || bucket.startHash!==(first?.block_hash ?? null) || bucket.endHash!==(last?.block_hash ?? null) || bucket.blockCount!==blocks.length)) reasons.push('bucket_provenance_mismatch');
        let estimates=null,work=[];
        if (numbers.length) {
          // Each count is capped and marked lower-bound if truncated; this is not a table-wide size query.
          estimates=(await client.query(`/* metrics:raw_counts */ SELECT
            (SELECT count(*) FROM (SELECT 1 FROM arc_intelligence_transactions WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) LIMIT $3) q) AS transactions,
            (SELECT count(*) FROM (SELECT 1 FROM arc_intelligence_receipts WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) LIMIT $3) q) AS receipts,
            (SELECT count(*) FROM (SELECT 1 FROM arc_intelligence_logs WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) LIMIT $3) q) AS logs,
            (SELECT count(*) FROM (SELECT 1 FROM arc_intelligence_reconciliation WHERE chain_id=$1 AND block_number=ANY($2::bigint[]) LIMIT $3) q) AS reconciliation,
            (SELECT count(*) FROM (SELECT 1 FROM arc_intelligence_coverage WHERE chain_id=$1 AND start_block >= $4 AND end_block <= $5 LIMIT $3) q) AS coverage`,
          [ARC_CHAIN_ID,numbers,MAX_HOURLY_FACT_ROWS+1,from,to])).rows[0];
          work=(await client.query(`/* metrics:unresolved */ SELECT state,count(*) AS count FROM arc_intelligence_work
            WHERE chain_id=$1 AND start_block <= $3 AND end_block >= $2 AND state<>'complete' GROUP BY state`,[ARC_CHAIN_ID,from,to])).rows;
        }
        if (work.length) reasons.push('unresolved_work_references');
        const counts=estimates ? Object.fromEntries(Object.entries(estimates).map(([name,count]) => [name,position(count)])) : null;
        if (counts && Object.values(counts).some((n) => n>MAX_HOURLY_FACT_ROWS)) reasons.push('raw_row_estimate_bounded_limit');
        const coreRetentionPrerequisitesSatisfied=reasons.length===0;
        // No caller switch can enable deletion. Protocol/registry/metadata evidence is not durable in A2 yet.
        reasons.push('required_reducers_incomplete','raw_deletion_disabled');
        return {dryRun:true,eligible:false,rawPrunable:false,coreRetentionPrerequisitesSatisfied,
          candidateStartBlock:from,candidateEndBlock:to,blockCount:blocks.length,
          estimatedRawRowsAffected:counts ? {blocks:blocks.length,...counts} : null,
          estimatesExact:!!counts && Object.values(counts).every((n) => n<=MAX_HOURLY_FACT_ROWS),
          unresolvedWork:Object.fromEntries(work.map((r) => [r.state,position(r.count)])),
          requiredReducersComplete:false,rawKeepSeconds:RAW_KEEP_SECONDS,coverage:current.coverage,reasons};
      } finally {client.release();}
    },
  });
}
