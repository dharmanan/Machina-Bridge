import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { CHAIN_IDENTITY, hash, manifestBlock, position } from './foundation.js';

export function normalizeManifest(raw, requestedBlock) {
  if (!raw || !Array.isArray(raw.transactions)) throw new Error('block_unavailable');
  const number = quantityToSafeNumber(raw.number);
  if (number !== requestedBlock) throw new Error('block_unavailable');
  // Hash-only transaction lists are enough for the manifest; receipts are deliberately not requested.
  const transactions = raw.transactions.map((transaction) => hash(typeof transaction === 'string' ? transaction : transaction?.hash));
  if (new Set(transactions).size !== transactions.length) throw new Error('block_unavailable');
  return manifestBlock({ block_number:number,block_hash:raw.hash,parent_hash:raw.parentHash,
    timestamp:quantityToSafeNumber(raw.timestamp),transaction_count:transactions.length });
}

// Explicit opt-in only: production main.js continues to start just the A1 indexer.
export function createChainFollower({ repository, rpc, identity = CHAIN_IDENTITY, maxBlocks = 25, finalityBlocks = 2 } = {}) {
  if (!repository || rpc?.url !== ARC_RPC_URL || !Number.isSafeInteger(maxBlocks)
    || maxBlocks < 1 || maxBlocks > MAX_WINDOW_SIZE || !Number.isSafeInteger(finalityBlocks)
    || finalityBlocks < 0 || finalityBlocks > 10000) throw new Error('invalid_chain_follower');
  let active = false;
  return {
    async tick({ signal } = {}) {
      if (active) return { skipped:true };
      active = true;
      let persistedBlocks = 0;
      let errorCode = 'database_unavailable';
      try {
        let lane = await repository.getLane(identity) ?? await repository.initializeChainLane(identity);
        if (lane.status === 'continuity_error') return { status:'continuity_error',persistedBlocks };
        errorCode = 'rpc_head_unavailable';
        if (signal?.aborted) return { status:'aborted',persistedBlocks };
        if (quantityToSafeNumber(await rpc.request('eth_chainId',[],{signal})) !== ARC_CHAIN_ID) throw new Error('noncanonical_chain');
        const head = quantityToSafeNumber(await rpc.request('eth_blockNumber',[],{signal}));
        await repository.setLaneStatus(identity,'indexing',null,head);
        if (head < finalityBlocks) throw new Error('rpc_head_unavailable');
        const targetHead = head-finalityBlocks;
        let next = lane.contiguous_complete_through === null ? position(lane.origin_block) : position(lane.contiguous_complete_through)+1;
        while (next <= targetHead && persistedBlocks < maxBlocks) {
          if (signal?.aborted) return { status:'aborted',persistedBlocks };
          errorCode = 'block_unavailable';
          const block = normalizeManifest(await rpc.request('eth_getBlockByNumber',[`0x${next.toString(16)}`,false],{signal}),next);
          if (signal?.aborted) return { status:'aborted',persistedBlocks };
          errorCode = 'database_unavailable';
          lane = await repository.persistManifest(identity,[block]);
          persistedBlocks++;
          next = position(lane.contiguous_complete_through)+1;
        }
        const status = next > targetHead ? 'caught_up' : 'indexing';
        await repository.setLaneStatus(identity,status,null,head);
        return { status,persistedBlocks,observedHead:head,targetHead,coreComplete:false };
      } catch (error) {
        if (signal?.aborted) return { status:'aborted',persistedBlocks };
        if (['checkpoint_parent_hash_mismatch','manifest_conflict','lane_continuity_stopped'].includes(error.message)) {
          return { status:'continuity_error',persistedBlocks };
        }
        await repository.setLaneStatus(identity,'retrying',errorCode).catch(() => {});
        return { status:'retrying',error:errorCode,persistedBlocks };
      } finally { active = false; }
    },
  };
}
