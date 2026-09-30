import { pruneCompleteWork } from './work-retention.js';
import { withTransaction, requireWorkLease } from './a2-db.js';
import { blockTransactions, persistTransactions } from './transaction-facts.js';
import { createHash } from 'node:crypto';
import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { FOUNDATION_EPOCH, captureA1Anchor } from './migrate.js';

export const CHAIN_IDENTITY = Object.freeze({ chainId: ARC_CHAIN_ID, lane: 'chain', scopeId: 'canonical_blocks',
  epoch: FOUNDATION_EPOCH, definitionVersion: 'arc-chain-manifest-v1' });
export const MAX_WORK_ROWS = 10000;
const REASONS = new Set(['rpc_head_unavailable', 'block_unavailable', 'checkpoint_parent_hash_mismatch',
  'manifest_conflict', 'database_unavailable', 'required_read_unavailable', 'unsupported_scope']);
export function reasonCode(value) {
  if (value === null) return null;
  if (!REASONS.has(value)) throw new Error('invalid_reason_code');
  return value;
}
export function position(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('invalid_block_position');
  return Number(value);
}
export function hash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('invalid_block_hash');
  return value.toLowerCase();
}
function label(value, max = 100) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(value) || value.length > max) throw new Error('invalid_identity');
  return value;
}
export function identityValues(identity) {
  if (identity.chainId !== ARC_CHAIN_ID) throw new Error('noncanonical_chain');
  return [ARC_CHAIN_ID, label(identity.lane), label(identity.scopeId), label(identity.epoch), label(identity.definitionVersion)];
}
function range(start, end) {
  start = position(start); end = position(end);
  if (end < start || end - start >= MAX_WINDOW_SIZE) throw new Error('invalid_work_range');
  return [start, end];
}
export function manifestBlock(block) {
  const result = { block_number: position(block.block_number), block_hash: hash(block.block_hash),
    parent_hash: hash(block.parent_hash), timestamp: position(block.timestamp), transaction_count: position(block.transaction_count) };
  if (result.transaction_count > 2147483647 || result.block_number >= Number.MAX_SAFE_INTEGER) throw new Error('invalid_manifest');
  return result;
}
export function manifestCoverage(identity, blocks, state = 'partial', dimension = 'chain_manifest') {
  identityValues(identity);
  if (!blocks.length || blocks.length > MAX_WINDOW_SIZE || !['partial', 'complete'].includes(state)
    || dimension !== 'chain_manifest') throw new Error('invalid_chain_coverage');
  const facts = blocks.map(manifestBlock);
  facts.forEach((block, index) => {
    if (index && (block.block_number !== facts[index - 1].block_number + 1
      || block.parent_hash !== facts[index - 1].block_hash)) throw new Error('invalid_chain_coverage');
  });
  return { startBlock: facts[0].block_number, endBlock: facts.at(-1).block_number,
    startHash: facts[0].block_hash, endHash: facts.at(-1).block_hash, dimension, state,
    evidenceDigest: createHash('sha256').update(JSON.stringify({ identity:identityValues(identity), facts })).digest('hex') };
}

// This repository only writes A2 tables. Empty migration anchors may bootstrap via one read of A1 state.
export function createFoundationRepository(pool) {
  const transaction = (work) => withTransaction(pool,work);
  const laneWhere = 'chain_id=$1 AND lane=$2 AND scope_id=$3 AND epoch=$4 AND definition_version=$5';
  async function lane(client, identity, lock = false) {
    return (await client.query(`/* a2:lane */ SELECT * FROM arc_intelligence_lanes WHERE ${laneWhere}${lock ? ' FOR UPDATE' : ''}`,
      identityValues(identity))).rows[0] ?? null;
  }
  const leaseGuard = requireWorkLease;
  async function coverage(client, identity, value) {
    await client.query(`/* a2:coverage */ INSERT INTO arc_intelligence_coverage
      (chain_id,lane,scope_id,epoch,definition_version,start_block,end_block,start_hash,end_hash,coverage_dimension,evidence_digest,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (chain_id,lane,scope_id,epoch,definition_version,coverage_dimension,start_block,end_block)
      DO UPDATE SET state=EXCLUDED.state,evidence_digest=EXCLUDED.evidence_digest,updated_at=now()`,
    [...identityValues(identity), value.startBlock, value.endBlock, value.startHash, value.endHash,
      value.dimension, value.evidenceDigest, value.state]);
  }
  return {
    async initializeChainLane(identity = CHAIN_IDENTITY) {
      if (identity.lane !== 'chain' || identity.scopeId !== 'canonical_blocks') throw new Error('invalid_chain_lane');
      return this.initializeLane(identity);
    },
    async initializeLane(identity = CHAIN_IDENTITY) {
      identityValues(identity);
      return transaction(async (client) => {
        let metadata = (await client.query(`/* a2:anchor */ SELECT metadata FROM arc_intelligence_migrations WHERE version=$1 FOR UPDATE`,
          ['002_a2_foundation'])).rows[0]?.metadata;
        if (!metadata || identity.epoch !== metadata.epoch) throw new Error('a1_anchor_unavailable');
        if (metadata.anchor === null) {
          const captured = captureA1Anchor((await client.query('SELECT * FROM arc_intelligence_state WHERE id = 1')).rows[0]);
          if (!captured.anchor || captured.anchor.nextBlock === null) throw new Error('a1_anchor_unavailable');
          metadata = { ...metadata, anchor:captured.anchor };
          await client.query(`/* a2:capture_anchor */ UPDATE arc_intelligence_migrations SET metadata=$2
            WHERE version=$1 AND metadata->'anchor' = 'null'::jsonb`, ['002_a2_foundation',JSON.stringify(metadata)]);
        }
        const anchor = metadata.anchor;
        if (!anchor) throw new Error('a1_anchor_unavailable');
        // Validate an existing anchor too, without refreshing it from newer A1 progress.
        captureA1Anchor({ chain_id:ARC_CHAIN_ID, source:ARC_RPC_URL, last_indexed_block:anchor.lastIndexedBlock,
          last_indexed_hash:anchor.lastIndexedHash, next_block:anchor.nextBlock });
        if (anchor.nextBlock === null) throw new Error('a1_anchor_unavailable');
        await client.query(`/* a2:initialize */ INSERT INTO arc_intelligence_lanes
          (chain_id,lane,scope_id,epoch,definition_version,origin_block,anchor_block,anchor_hash,anchor_next_block)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6) ON CONFLICT DO NOTHING`,
        [...identityValues(identity), position(anchor.nextBlock), anchor.lastIndexedBlock, anchor.lastIndexedHash]);
        return lane(client, identity);
      });
    },
    async getLane(identity = CHAIN_IDENTITY) {
      const client = await pool.connect();
      try { return await lane(client, identity); } finally { client.release(); }
    },
    async setLaneStatus(identity, status, error = null, observedHead = null) {
      if (!['starting','indexing','caught_up','retrying','persistent_partial','continuity_error'].includes(status)) throw new Error('invalid_lane_status');
      if (observedHead !== null) position(observedHead);
      return transaction(async (client) => {
        await client.query(`/* a2:status */ UPDATE arc_intelligence_lanes SET status=$6,current_error_code=$7,
          observed_head=COALESCE($8,observed_head),updated_at=now() WHERE ${laneWhere} AND status <> 'continuity_error'`,
        [...identityValues(identity), status, reasonCode(error), observedHead]);
      });
    },
    async persistManifest(identity, input, lease = null) {
      if (identity.lane !== 'chain' || identity.scopeId !== 'canonical_blocks') throw new Error('invalid_chain_lane');
      if (!input.length || input.length > MAX_WINDOW_SIZE) throw new Error('invalid_manifest_range');
      const transactionSets = new Map(input.map((block) => [position(block.block_number),blockTransactions(block,manifestBlock(block))]));
      const blocks = input.map(manifestBlock).sort((a,b) => a.block_number-b.block_number);
      if (new Set(blocks.map((b) => b.block_number)).size !== blocks.length) throw new Error('duplicate_input_block');
      range(blocks[0].block_number, blocks.at(-1).block_number);
      let result;
      try { result = await transaction(async (client) => {
        const job = lease ? await leaseGuard(client, lease) : null;
        if (job && (identityValues(identity).some((value,i) => value !== [job.chain_id,job.lane,job.scope_id,job.epoch,job.definition_version][i])
          || blocks.length !== position(job.end_block)-position(job.start_block)+1
          || blocks.some((b,index) => b.block_number !== position(job.start_block)+index)
          || (job.block_hash && blocks.some((b) => b.block_hash !== job.block_hash)))) throw new Error('work_identity_mismatch');
        const state = await lane(client, identity, true);
        if (!state) throw new Error('lane_uninitialized');
        if (state.status === 'continuity_error') throw new Error('lane_continuity_stopped');
        if (blocks.some((b) => b.block_number < position(state.origin_block))) throw new Error('before_lane_origin');
        // Serialize manifest writes across epochs too; canonical block identity is shared.
        await client.query('SELECT pg_advisory_xact_lock(5042,177003)');
        const existing = (await client.query(`/* a2:neighbors */ SELECT * FROM arc_intelligence_blocks
          WHERE chain_id=$1 AND block_number BETWEEN $2 AND $3 ORDER BY block_number`,
        [ARC_CHAIN_ID, Math.max(0, blocks[0].block_number-1), blocks.at(-1).block_number+1])).rows;
        const known = new Map(existing.map((b) => [position(b.block_number), manifestBlock(b)]));
        let conflict = null;
        for (const block of blocks) {
          const old = known.get(block.block_number);
          if (old && JSON.stringify(old) !== JSON.stringify(block)) conflict = 'manifest_conflict';
          known.set(block.block_number, block);
        }
        for (const block of blocks) {
          const previous = known.get(block.block_number-1);
          const next = known.get(block.block_number+1);
          if ((previous && block.parent_hash !== previous.block_hash) || (next && next.parent_hash !== block.block_hash)
            || (block.block_number === position(state.origin_block) && state.anchor_hash && block.parent_hash !== state.anchor_hash)) {
            conflict ??= 'checkpoint_parent_hash_mismatch';
          }
        }
        if (conflict) {
          await client.query(`/* a2:halt */ UPDATE arc_intelligence_lanes SET status='continuity_error',current_error_code=$6,
            updated_at=now() WHERE ${laneWhere}`, [...identityValues(identity), conflict]);
          return { error: conflict };
        }
        for (const block of blocks) {
          await client.query(`/* a2:block */ INSERT INTO arc_intelligence_blocks
            (chain_id,block_number,block_hash,parent_hash,timestamp,transaction_count) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (chain_id,block_number) DO NOTHING`, [ARC_CHAIN_ID, block.block_number, block.block_hash,
            block.parent_hash, block.timestamp, block.transaction_count]);
        }
        for (const block of blocks) await persistTransactions(client,block,transactionSets.get(block.block_number));
        const start = state.contiguous_complete_through === null ? position(state.origin_block) : position(state.contiguous_complete_through)+1;
        const available = (await client.query(`/* a2:advance */ SELECT * FROM arc_intelligence_blocks
          WHERE chain_id=$1 AND block_number >= $2 ORDER BY block_number LIMIT $3`, [ARC_CHAIN_ID,start,MAX_WINDOW_SIZE])).rows.map((row) => ({ ...manifestBlock(row),transactions_complete:row.transactions_complete }));
        const contiguous = [];
        let previousHash = state.checkpoint_hash ?? state.anchor_hash;
        for (const block of available) {
          if (block.block_number !== start+contiguous.length || block.transactions_complete !== true) break;
          if (previousHash && block.parent_hash !== previousHash) throw new Error('persisted_continuity_invalid');
          contiguous.push(block); previousHash = block.block_hash;
        }
        const completeThrough = contiguous.at(-1)?.block_number ?? state.contiguous_complete_through;
        if (contiguous.length) await coverage(client, identity, manifestCoverage(identity,contiguous,'complete'));
        if (completeThrough !== null) await client.query(`/* a2:promote_coverage */ UPDATE arc_intelligence_coverage
          SET state='complete',updated_at=now() WHERE ${laneWhere} AND coverage_dimension='chain_manifest'
          AND state='partial' AND end_block <= $6`, [...identityValues(identity),completeThrough]);
        for (const block of blocks) {
          if (completeThrough === null || block.block_number > position(completeThrough)) {
            await coverage(client,identity,manifestCoverage(identity,[block],'partial'));
          }
        }
        const processed = Math.max(state.processed_through === null ? -1 : position(state.processed_through),
          blocks.at(-1).block_number, completeThrough === null ? -1 : position(completeThrough));
        await client.query(`/* a2:progress */ UPDATE arc_intelligence_lanes SET processed_through=$6,
          contiguous_complete_through=$7,checkpoint_hash=$8,status='indexing',current_error_code=NULL,
          last_success_at=now(),updated_at=now() WHERE ${laneWhere}`,
        [...identityValues(identity),processed,completeThrough,completeThrough === null ? null : previousHash]);
        if (lease) await client.query(`/* a2:finish */ UPDATE arc_intelligence_work SET state='complete',reason_code=NULL,
          lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id]);
        if (lease) await pruneCompleteWork(client);
        return lane(client,identity);
      }); } catch (error) {
        if (['persisted_continuity_invalid','transaction_identity_conflict'].includes(error.message)) {
          const code = error.message === 'transaction_identity_conflict' ? 'manifest_conflict' : 'checkpoint_parent_hash_mismatch';
          await this.setLaneStatus(identity,'continuity_error',code);
          throw new Error(code);
        }
        throw error;
      }
      if (result.error) throw new Error(result.error);
      return result;
    },
    async enqueue(identity, { component, logicalKey, startBlock, endBlock, blockHash = null }) {
      const bounds = range(startBlock,endBlock);
      if (blockHash !== null && bounds[0] !== bounds[1]) throw new Error('invalid_block_identity_range');
      const key = [...identityValues(identity),label(component),label(logicalKey,200)];
      const expected = [...bounds,blockHash === null ? null : hash(blockHash)];
      return transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(5042,177004)');
        await pruneCompleteWork(client);
        const existing = (await client.query(`/* a2:work_existing */ SELECT * FROM arc_intelligence_work
          WHERE ${laneWhere} AND component=$6 AND logical_key=$7`, key)).rows[0];
        if (existing) {
          if (position(existing.start_block) !== bounds[0] || position(existing.end_block) !== bounds[1]
            || existing.block_hash !== expected[2]) throw new Error('work_identity_conflict');
          return existing;
        }
        const count = (await client.query('/* a2:work_count */ SELECT count(*) AS count FROM arc_intelligence_work WHERE state <> \'complete\'')).rows[0].count;
        if (position(count) >= MAX_WORK_ROWS) throw new Error('work_capacity_reached');
        return (await client.query(`/* a2:enqueue */ INSERT INTO arc_intelligence_work
          (chain_id,lane,scope_id,epoch,definition_version,component,logical_key,start_block,end_block,block_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [...key,...expected])).rows[0];
      });
    },
    async claim(identity, owner, leaseMs = 30000) {
      label(owner);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new Error('invalid_lease_duration');
      return transaction(async (client) => (await client.query(`/* a2:claim */ WITH candidate AS (
        SELECT id FROM arc_intelligence_work WHERE ${laneWhere} AND not_before <= now()
          AND (state IN ('pending','retrying') OR (state='leased' AND lease_until <= now()))
        ORDER BY not_before,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE arc_intelligence_work w SET state='leased',attempts=w.attempts+1,
        fencing_token=w.fencing_token+1,lease_owner=$6,lease_until=now()+$7*interval '1 millisecond',updated_at=now()
        FROM candidate c WHERE w.id=c.id RETURNING w.*`, [...identityValues(identity),owner,leaseMs])).rows[0] ?? null);
    },
    async finishWork(lease, { state = 'complete', reason = null, retryMs = 1000 } = {}) {
      if (!['complete','retrying','failed','persistent_partial'].includes(state)
        || !Number.isSafeInteger(retryMs) || retryMs < 0 || retryMs > 3600000) throw new Error('invalid_work_result');
      reasonCode(reason);
      if ((state === 'complete' && reason !== null) || (state !== 'complete' && reason === null)) throw new Error('invalid_work_reason');
      if (['failed','persistent_partial'].includes(state) && reason !== 'unsupported_scope') throw new Error('transient_failure_requires_retry');
      return transaction(async (client) => {
        const job = await leaseGuard(client,lease);
        const result = (await client.query(`/* a2:result */ UPDATE arc_intelligence_work SET state=$2,reason_code=$3,
          not_before=now()+$4*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [job.id,state,reason,retryMs])).rows[0];
        if (state === 'complete') await pruneCompleteWork(client);
        return result;
      });
    },
  };
}
