import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { CHAIN_IDENTITY, position } from './foundation.js';
import { normalizeChainBlock } from './transaction-facts.js';

export function normalizeManifest(raw, requestedBlock) {
  return normalizeChainBlock(raw,requestedBlock);
}

// Started only by the explicit A2 runtime; contiguous mode remains available to foundation callers.
export function createChainFollower({ repository, rpc, identity = CHAIN_IDENTITY, maxBlocks = 25, finalityBlocks = 2, mode = 'contiguous' } = {}) {
  if (!repository || rpc?.url !== ARC_RPC_URL || !rpc.budget || typeof rpc.requestBlockRange !== 'function' || !Number.isSafeInteger(maxBlocks)
    || maxBlocks < 1 || maxBlocks > MAX_WINDOW_SIZE || !Number.isSafeInteger(finalityBlocks)
    || finalityBlocks < 0 || finalityBlocks > 10000 || !['contiguous','live'].includes(mode)) throw new Error('invalid_chain_follower');
  let active = false;
  let chainVerified = false;
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
        if (!chainVerified) {
          if (quantityToSafeNumber(await rpc.request('eth_chainId',[],{signal})) !== ARC_CHAIN_ID) throw new Error('noncanonical_chain');
          chainVerified = true;
        }
        const head = quantityToSafeNumber(await rpc.request('eth_blockNumber',[],{signal}));
        await repository.setLaneStatus(identity,'indexing',null,head);
        if (head < finalityBlocks) throw new Error('rpc_head_unavailable');
        const targetHead = head-finalityBlocks;
        let next = lane.contiguous_complete_through === null ? position(lane.origin_block) : position(lane.contiguous_complete_through)+1;
        if (mode === 'live') {
          // A live-floor jump is bootstrap only. Once a live tail exists, never create another gap.
          next = lane.processed_through === null
            ? Math.max(position(lane.origin_block),targetHead-maxBlocks+1)
            : position(lane.processed_through)+1;
        }
        if (next <= targetHead) {
          if (signal?.aborted) return { status:'aborted',persistedBlocks };
          errorCode = 'block_unavailable';
          const batchEnd = Math.min(next+maxBlocks-1,targetHead);
          const raw = await rpc.requestBlockRange(next,batchEnd,{signal});
          if (!Array.isArray(raw) || raw.length !== batchEnd-next+1) throw new Error('block_unavailable');
          const blocks = raw.map((block,i) => normalizeManifest(block,next+i));
          if (new Set(blocks.map((b) => b.block_number)).size !== blocks.length) throw new Error('block_unavailable');
          if (blocks.some((block,i) => i > 0 && block.parent_hash !== blocks[i-1].block_hash)) {
            await repository.setLaneStatus(identity,'continuity_error','checkpoint_parent_hash_mismatch');
            throw new Error('checkpoint_parent_hash_mismatch');
          }
          if (signal?.aborted) return { status:'aborted',persistedBlocks };
          errorCode = 'database_unavailable';
          lane = await repository.persistManifest(identity,blocks);
          persistedBlocks = blocks.length;
          next = mode === 'live' ? batchEnd+1 : position(lane.contiguous_complete_through)+1;
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
